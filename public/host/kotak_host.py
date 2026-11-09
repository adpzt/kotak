#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Moteur local d'Kotak (Native Messaging) : pilote yt-dlp et ffmpeg pour le module Médias.

Protocole : messages JSON préfixés par leur longueur (4 octets), sur stdin / stdout.
Chaque requête porte un `id` ; les réponses reprennent cet `id` :
  {type: "result", data}            réponse simple
  {type: "progress"|"stage", ...}   avancement d'un téléchargement
  {type: "done", file, size}        fichier prêt
  {type: "chunk", chunk, last}      fichier renvoyé par morceaux (limite de 1 Mo par message)
  {type: "error", message}

Compatible avec le Python 3.9 fourni par macOS (outils de ligne de commande).
"""
import base64
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading

WINDOWS = os.name == "nt"
# Emplacements surchargeables (tests isolés) via KOTAK_BASE / KOTAK_BIN / KOTAK_DIR.
if WINDOWS:
    _default_base = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Kotak")
else:
    _default_base = os.path.expanduser("~/Library/Application Support/Kotak")
BASE = os.environ.get("KOTAK_BASE") or _default_base
BIN = os.environ.get("KOTAK_BIN") or os.path.join(BASE, "bin")
_EXE = ".exe" if WINDOWS else ""
YTDLP = os.path.join(BIN, "yt-dlp" + _EXE)
FFMPEG = os.path.join(BIN, "ffmpeg" + _EXE)
FFPROBE = os.path.join(BIN, "ffprobe" + _EXE)
# Windows : pas de fenêtre de console pour les outils lancés en arrière-plan.
_NO_WINDOW = 0x08000000 if WINDOWS else 0

if WINDOWS:
    import msvcrt  # noqa: E402

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
CONFIG = os.path.join(BASE, "config.json")
DEFAULT_DIR = os.environ.get("KOTAK_DIR") or os.path.expanduser("~/Downloads/Kotak Médias")

_out_lock = threading.Lock()
_stdout_ok = True
_jobs = {}  # id -> subprocess.Popen en cours
_cancelled = set()


# ---------------------------------------------------------------- messagerie
def send(obj):
    global _stdout_ok
    if not _stdout_ok:
        return
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    try:
        with _out_lock:
            sys.stdout.buffer.write(struct.pack("@I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        # Panneau fermé : les téléchargements en cours continuent sans affichage.
        _stdout_ok = False


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- réglages
def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    os.makedirs(BASE, exist_ok=True)
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def download_dir():
    d = load_config().get("dir") or DEFAULT_DIR
    os.makedirs(d, exist_ok=True)
    return d


def run_quiet(args, timeout=60):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=_NO_WINDOW)


# ---------------------------------------------------------------- messages d'erreur lisibles
def friendly(stderr):
    s = stderr or ""
    rules = [
        (r"HTTP Error 403|403 Forbidden", "Le site a refusé temporairement l'accès (erreur 403) : réessaie dans un instant, ou choisis ta session navigateur dans « Session »."),
        (r"confirm you.re not a bot|Sign in to confirm", "YouTube demande une connexion : choisis ta session navigateur (ex. Brave) dans « Session » puis réessaie."),
        (r"login required|requires authentication|rate-limit reached|private|log in", "Contenu protégé ou privé : choisis ta session navigateur dans « Session » (tu dois être connecté au site)."),
        (r"Unsupported URL", "Lien non pris en charge par le moteur."),
        (r"Video unavailable|This video is unavailable|404", "Vidéo indisponible (supprimée, privée ou bloquée dans ce pays)."),
        (r"No video formats found|Requested format is not available", "Aucun format compatible pour cette qualité : essaie « Max » ou une autre qualité."),
        (r"could not find .* cookies|cookies database", "Impossible de lire la session du navigateur choisi (est-il installé et as-tu autorisé l'accès au trousseau ?)."),
        (r"Unable to download|HTTP Error|Connection|timed out", "Problème réseau pendant le téléchargement : réessaie."),
    ]
    for pattern, msg in rules:
        if re.search(pattern, s, re.I):
            return msg
    lines = [l for l in s.strip().splitlines() if "ERROR" in l] or s.strip().splitlines()[-1:]
    return (lines[-1] if lines else "Erreur inconnue").replace("ERROR: ", "")[:300]


def base_args(cookies):
    args = [YTDLP, "--no-playlist", "--no-warnings", "--ffmpeg-location", BIN, "--no-mtime"]
    if cookies:
        args += ["--cookies-from-browser", cookies]
    return args


# ---------------------------------------------------------------- commandes simples
def cmd_status(msg):
    yt = run_quiet([YTDLP, "--version"]).stdout.strip()
    ff = run_quiet([FFMPEG, "-hide_banner", "-version"]).stdout.splitlines()[0].split(" ")[2]
    return {"ytdlp": yt, "ffmpeg": ff, "dir": download_dir()}


SITE_NAMES = {"Youtube": "YouTube", "YoutubeTab": "YouTube", "TikTok": "TikTok", "Instagram": "Instagram", "Twitter": "X", "Vimeo": "Vimeo", "Facebook": "Facebook", "Soundcloud": "SoundCloud", "Dailymotion": "Dailymotion", "Twitch": "Twitch"}


def best_thumbnail(info):
    """Miniature JPG ou PNG de préférence (affichage le plus fiable dans le panneau)."""
    thumbs = [t for t in (info.get("thumbnails") or []) if t.get("url")]
    good = [t for t in thumbs if re.search(r"\.(jpe?g|png)(\?|$)", t["url"], re.I)]
    pick = (good or thumbs)
    if pick:
        return max(pick, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0) or (t.get("preference") or 0))["url"]
    return info.get("thumbnail")


def cmd_probe(msg):
    r = run_quiet(base_args(msg.get("cookies")) + ["-J", msg["url"]], timeout=90)
    if r.returncode != 0:
        raise RuntimeError(friendly(r.stderr))
    info = json.loads(r.stdout)
    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]
    formats = info.get("formats") or []
    heights = [f.get("height") or 0 for f in formats if (f.get("vcodec") or "none") != "none"]
    has_audio = any((f.get("acodec") or "none") != "none" for f in formats) or bool(info.get("acodec"))
    return {
        "url": info.get("webpage_url") or msg["url"],
        "title": info.get("title") or "Sans titre",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration"),
        "thumbnail": best_thumbnail(info),
        "site": SITE_NAMES.get(info.get("extractor_key") or "", info.get("extractor_key") or info.get("extractor") or ""),
        "maxHeight": max(heights) if heights else (info.get("height") or None),
        "hasVideo": bool(heights) or bool(info.get("height")),
        "hasAudio": has_audio,
        "formats": format_sizes(formats, info.get("duration")),
    }


def format_sizes(formats, duration):
    """Poids de chaque flux (pour estimer le fichier avant téléchargement) :
    vidéo [{h, h264, size}] et meilleur audio seul {size, aac}."""
    def size_of(f):
        size = f.get("filesize") or f.get("filesize_approx")
        if not size and f.get("tbr") and duration:
            size = f["tbr"] * 1000 / 8 * duration
        return int(size or 0)

    video, audio = [], None
    for f in formats:
        size = size_of(f)
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        if vcodec != "none" and size:
            video.append({"h": f.get("height") or 0, "h264": vcodec.startswith(("avc", "h264")), "size": size, "muxed": acodec != "none",
                          "hls": "m3u8" in (f.get("protocol") or ""), "pref": f.get("preference") or 0})
        elif vcodec == "none" and acodec != "none" and size:
            cand = {"size": size, "aac": acodec.startswith("mp4a"), "abr": f.get("abr") or f.get("tbr") or 0}
            if audio is None or cand["abr"] > audio["abr"]:
                audio = cand
    return {"video": video, "audio": audio}


def cmd_choose_dir(msg):
    if WINDOWS:
        ps = ("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
              "$d.Description = 'Dossier des téléchargements Kotak'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }")
        r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True, timeout=600)
        if not r.stdout.strip():
            raise RuntimeError("Aucun dossier choisi")
    else:
        script = 'POSIX path of (choose folder with prompt "Dossier des téléchargements Kotak")'
        r = run_quiet(["osascript", "-e", script], timeout=600)
    if r.returncode != 0:
        raise RuntimeError("Aucun dossier choisi")
    path = r.stdout.strip().rstrip("/")
    cfg = load_config()
    cfg["dir"] = path
    save_config(cfg)
    return {"dir": path}


def cmd_reveal(msg):
    if WINDOWS:
        subprocess.run(["explorer", "/select,", os.path.normpath(msg["file"])])
    else:
        subprocess.run(["open", "-R", msg["file"]])
    return {}


def cmd_open(msg):
    if WINDOWS:
        os.startfile(msg["file"])  # noqa: S606
    else:
        subprocess.run(["open", msg["file"]])
    return {}


def send_file(msg_id, path):
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    size = 700_000
    parts = [data[i:i + size] for i in range(0, len(data), size)] or [""]
    for i, part in enumerate(parts):
        send({"id": msg_id, "type": "chunk", "seq": i, "chunk": part, "last": i == len(parts) - 1})


def cmd_cancel(msg):
    job = msg.get("job")
    _cancelled.add(job)
    proc = _jobs.get(job)
    if proc and proc.poll() is None:
        try:
            if WINDOWS:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, creationflags=_NO_WINDOW)
            else:
                os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            proc.terminate()
    return {}


# ---------------------------------------------------------------- téléchargement
PROGRESS_RE = re.compile(r"^ATL\s+([\d.]+)%?\|([^|]*)\|(.*)$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def spawn(job_id, args, cwd=None):
    proc = subprocess.Popen(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        start_new_session=not WINDOWS,
        creationflags=_NO_WINDOW,
    )
    _jobs[job_id] = proc
    return proc


def probe_media(path):
    r = run_quiet([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path])
    try:
        data = json.loads(r.stdout)
    except Exception:
        return {}, None, 0.0
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = float(data.get("format", {}).get("duration") or 0)
    return v or {}, a, dur


def run_ffmpeg(job_id, args, duration, stage, span=(0.0, 100.0), cwd=None):
    """Lance ffmpeg en suivant son avancement (-progress).
    span = (début, largeur) : part de la barre de progression couverte par cette étape."""
    send({"id": job_id, "type": "stage", "stage": stage})
    proc = spawn(job_id, [FFMPEG, "-hide_banner", "-nostats", "-progress", "pipe:1", "-y"] + args, cwd=cwd)
    err_lines = []

    def drain_err():
        for line in proc.stderr:
            err_lines.append(line)

    t = threading.Thread(target=drain_err, daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration > 0:
            try:
                us = int(line.split("=")[1])
                done = max(0.0, min(1.0, us / 1e6 / duration))
                send({"id": job_id, "type": "progress", "percent": span[0] + done * span[1], "stage": stage})
            except ValueError:
                pass
    proc.wait()
    t.join(timeout=2)
    if job_id in _cancelled:
        raise RuntimeError("Annulé")
    if proc.returncode != 0:
        raise RuntimeError("Conversion impossible : " + "".join(err_lines[-3:]).strip()[:300])


def video_bitrate(height, codec):
    if height >= 4000:
        br = 90
    elif height >= 2000:
        br = 45
    elif height >= 1400:
        br = 24
    elif height >= 1000:
        br = 12
    elif height >= 700:
        br = 7
    else:
        br = 4
    if codec == "hevc":
        br = max(3, int(br * 0.6))
    return "%dM" % br


def unique_path(folder, name):
    stem, ext = os.path.splitext(name)
    path = os.path.join(folder, name)
    i = 2
    while os.path.exists(path):
        path = os.path.join(folder, "%s (%d)%s" % (stem, i, ext))
        i += 1
    return path


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", name).strip(" .") or "media"
    return name[:150]


def run_ytdlp(job_id, args):
    """Lance yt-dlp en relayant l'avancement ; renvoie (code retour, erreurs)."""
    proc = spawn(job_id, args)
    err_lines = []

    def drain_err():
        for line in proc.stderr:
            err_lines.append(line)

    t = threading.Thread(target=drain_err, daemon=True)
    t.start()
    for line in proc.stdout:
        line = ANSI_RE.sub("", line).strip()
        m = PROGRESS_RE.match(line)
        if m:
            send({"id": job_id, "type": "progress", "percent": float(m.group(1)), "speed": m.group(2).strip(), "eta": m.group(3).strip(), "stage": "Téléchargement"})
        elif line.startswith("[Merger]"):
            send({"id": job_id, "type": "stage", "stage": "Assemblage vidéo + son"})
    proc.wait()
    t.join(timeout=2)
    return proc.returncode, "".join(err_lines)


def cmd_download(msg):
    job_id = msg["id"]
    tmp = tempfile.mkdtemp(prefix="kotak-")
    try:
        mode = msg.get("mode", "video")
        quality = int(msg.get("quality") or 0)
        container = msg.get("container", "mp4")
        codec = msg.get("codec", "original")
        if codec == "prores":
            container = "mov"
        args = base_args(msg.get("cookies")) + [
            "--newline",
            "--progress",
            "--progress-template", "download:ATL %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "-o", os.path.join(tmp, "%(title).150B.%(ext)s"),
        ]
        if msg.get("start") or msg.get("end"):
            args += ["--download-sections", "*%s-%s" % (msg.get("start") or "0", msg.get("end") or "inf"), "--force-keyframes-at-cuts"]
        sort = "res:%d,fps" % quality if quality else "res,fps"
        if mode == "video":
            if codec in ("h264", "original") and container in ("mp4", "mov"):
                sort += ",vcodec:h264,acodec:aac"
            args += ["-f", "bv*+ba/b", "-S", sort]
            args += ["--merge-output-format", container if codec == "original" else "mkv"]
        elif mode == "audio":
            args += ["-f", "ba/b"]
        else:
            args += ["--skip-download", "--write-thumbnail", "--convert-thumbnails", "png"]
        args.append(msg["url"])

        for attempt in (1, 2):
            send({"id": job_id, "type": "stage", "stage": "Téléchargement" if attempt == 1 else "Téléchargement (2e essai)"})
            returncode, stderr = run_ytdlp(job_id, args)
            if job_id in _cancelled:
                raise RuntimeError("Annulé")
            if returncode == 0:
                break
            # Refus passager du site (fréquent chez YouTube) : on réessaie une fois.
            if attempt == 1 and re.search(r"403", stderr):
                for f in os.listdir(tmp):
                    os.remove(os.path.join(tmp, f))
                continue
            raise RuntimeError(friendly(stderr))

        files = [os.path.join(tmp, f) for f in os.listdir(tmp) if not f.endswith((".part", ".ytdl", ".json"))]
        if mode == "image":
            files = [f for f in files if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if not files:
            raise RuntimeError("Aucun fichier produit")
        src = max(files, key=os.path.getsize)
        stem = safe_name(os.path.splitext(os.path.basename(src))[0])
        final_src = src

        if mode == "audio":
            _, _, dur = probe_media(src)
            fmt = msg.get("audio", "mp3")
            depth = int(msg.get("depth") or 16)
            codecs = {
                "mp3": (["-c:a", "libmp3lame", "-b:a", "%dk" % int(msg.get("bitrate") or 320)], "mp3"),
                "wav": (["-c:a", "pcm_s24le" if depth == 24 else "pcm_s16le", "-ar", "48000"], "wav"),
                "aiff": (["-c:a", "pcm_s24be" if depth == 24 else "pcm_s16be", "-ar", "48000"], "aiff"),
                "m4a": (["-c:a", "aac", "-b:a", "256k"], "m4a"),
                "flac": (["-c:a", "flac"], "flac"),
                "opus": (["-c:a", "libopus", "-b:a", "192k"], "opus"),
            }
            extra, ext = codecs.get(fmt, codecs["mp3"])
            out = os.path.join(tmp, "out." + ext)
            run_ffmpeg(job_id, ["-i", src, "-vn", "-map_metadata", "0"] + extra + [out], dur, "Conversion audio")
            final_src = out
            final_ext = ext
        elif mode == "video":
            v, a, dur = probe_media(src)
            vcodec = v.get("codec_name", "")
            height = int(v.get("height") or 0)
            ext = container
            out = os.path.join(tmp, "out." + ext)
            compress = int(msg.get("compress") or 0)
            if compress > 0 and codec != "prores" and container != "webm":
                # Poids de référence = celui du fichier qu'on aurait obtenu sans compression
                # (même calcul que l'estimation affichée dans le panneau).
                if codec == "original" or (codec == "h264" and vcodec == "h264"):
                    ref = os.path.getsize(src)
                else:
                    a_bits = (a.get("bit_rate") and int(a["bit_rate"]) or 256_000) if a else 0
                    ref = (int(video_bitrate(height, codec)[:-1]) * 1_000_000 + a_bits) * dur / 8
                target = int(ref * (100 - min(95, compress)) / 100)
                compress_video(job_id, src, out, target, "hevc" if codec == "hevc" else "h264", strip=False)
                final_src = out
                final_ext = ext
            elif codec == "original":
                final_src = src
                final_ext = os.path.splitext(src)[1].lstrip(".")
            else:
                audio_args = ["-c:a", "pcm_s16le"] if codec == "prores" else (["-c:a", "copy"] if (a and a.get("codec_name") == "aac") else ["-c:a", "aac", "-b:a", "256k"])
                if container == "webm":
                    audio_args = ["-c:a", "libopus", "-b:a", "192k"]
                if codec == "h264" and vcodec == "h264":
                    video_args = ["-c:v", "copy"]
                    stage = "Mise en forme"
                elif codec == "h264":
                    if WINDOWS:
                        video_args = ["-c:v", "libx264", "-preset", "faster", "-crf", "17", "-pix_fmt", "yuv420p"]
                    else:
                        video_args = ["-c:v", "h264_videotoolbox", "-b:v", video_bitrate(height, "h264"), "-profile:v", "high", "-pix_fmt", "yuv420p", "-tag:v", "avc1"]
                    stage = "Conversion H.264"
                elif codec == "hevc":
                    if WINDOWS:
                        video_args = ["-c:v", "libx265", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
                    else:
                        video_args = ["-c:v", "hevc_videotoolbox", "-b:v", video_bitrate(height, "hevc"), "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
                    stage = "Conversion HEVC"
                else:
                    video_args = ["-c:v", "prores_ks" if WINDOWS else "prores_videotoolbox", "-profile:v", "2"]
                    stage = "Conversion ProRes"
                faststart = ["-movflags", "+faststart"] if ext in ("mp4", "mov") else []
                try:
                    run_ffmpeg(job_id, ["-i", src, "-map", "0:v:0", "-map", "0:a?"] + video_args + audio_args + faststart + [out], dur, stage)
                except RuntimeError:
                    if job_id in _cancelled or codec != "prores":
                        raise
                    # Encodeur matériel ProRes indisponible (Mac Intel ancien) : encodeur logiciel.
                    video_args = ["-c:v", "prores_ks", "-profile:v", "2"]
                    run_ffmpeg(job_id, ["-i", src, "-map", "0:v:0", "-map", "0:a?"] + video_args + audio_args + faststart + [out], dur, stage)
                final_src = out
                final_ext = ext
        else:
            final_ext = os.path.splitext(src)[1].lstrip(".")

        dest = unique_path(download_dir(), "%s.%s" % (stem, final_ext))
        shutil.move(final_src, dest)
        send({"id": job_id, "type": "done", "file": dest, "size": os.path.getsize(dest)})
    finally:
        _jobs.pop(job_id, None)
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_frame(msg):
    """Image d'une vidéo en ligne à l'instant donné, lue dans le meilleur flux (avec les en-têtes de yt-dlp)."""
    r = run_quiet(base_args(msg.get("cookies")) + ["-j", "-f", "bv*/b", "-S", "res,fps", msg["url"]], timeout=90)
    if r.returncode != 0:
        raise RuntimeError(friendly(r.stderr))
    info = json.loads(r.stdout.strip().splitlines()[-1])
    fmt = info if info.get("url") else (info.get("requested_formats") or [{}])[0]
    if not fmt.get("url"):
        raise RuntimeError("Flux vidéo introuvable")
    headers = fmt.get("http_headers") or info.get("http_headers") or {}
    extra = "".join("%s: %s\r\n" % (k, v) for k, v in headers.items() if k.lower() != "user-agent")
    tmp = tempfile.mkdtemp(prefix="kotak-")
    try:
        out = os.path.join(tmp, "frame.png")
        t = max(0.0, float(msg.get("time") or 0))
        args = [FFMPEG, "-hide_banner", "-loglevel", "error"]
        if headers.get("User-Agent"):
            args += ["-user_agent", headers["User-Agent"]]
        if extra:
            args += ["-headers", extra]
        args += ["-ss", "%.3f" % t, "-i", fmt["url"], "-frames:v", "1", "-y", out]
        rr = run_quiet(args, timeout=180)
        if rr.returncode != 0 or not os.path.exists(out):
            raise RuntimeError("Capture impossible : " + (friendly(rr.stderr) if rr.stderr else "flux illisible"))
        send_file(msg["id"], out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- compression vidéo
# Encodage en deux passes vers un poids cible : la 1re passe analyse la vidéo, la 2e répartit
# le débit là où l'image en a besoin. C'est la meilleure qualité possible pour un poids donné.
HDR_TRC = ("arib-std-b67", "smpte2084")


def video_facts(path):
    """Caractéristiques utiles d'une vidéo (ffprobe)."""
    v, a, dur = probe_media(path)
    if not v:
        raise RuntimeError("Aucune piste vidéo lisible dans ce fichier")
    w, hgt = int(v.get("width") or 0), int(v.get("height") or 0)
    rot = 0
    for sd in v.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(sd.get("rotation") or 0)
    rot = rot or int((v.get("tags") or {}).get("rotate") or 0)
    if abs(rot) % 180 == 90:
        w, hgt = hgt, w
    fps = 30.0
    try:
        num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
        fps = float(num) / float(den) if float(den) else 30.0
    except (ValueError, ZeroDivisionError):
        pass
    pix = v.get("pix_fmt") or ""
    hdr = (v.get("color_transfer") or "") in HDR_TRC
    return {
        "width": w,
        "height": hgt,
        "fps": round(fps, 3) if 0 < fps < 400 else 30.0,
        "duration": dur,
        "codec": v.get("codec_name") or "",
        "hdr": hdr,
        "tenBit": "10" in pix or "12" in pix,
        "audio": (a or {}).get("codec_name"),
        "audioBitrate": int((a or {}).get("bit_rate") or 0),
        "size": os.path.getsize(path),
        "_v": v,
    }


def _scale_filter(max_side):
    """Réduit le petit côté à max_side (sans jamais agrandir) ; dimensions paires pour l'encodeur."""
    if not max_side:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    n = int(max_side)
    return ("scale=w='if(gte(iw,ih),-2,trunc(min(iw,%d)/2)*2)':h='if(gte(iw,ih),trunc(min(ih,%d)/2)*2,-2)'" % (n, n))


def compress_video(job_id, src, out, target, codec="h264", max_side=0, strip=True, span=(0.0, 100.0)):
    """Compresse src vers out (mp4/mov/mkv) en visant `target` octets. Renvoie une note éventuelle."""
    facts = video_facts(src)
    dur = facts["duration"]
    if dur <= 0:
        raise RuntimeError("Durée de la vidéo illisible")
    note = ""
    if facts["hdr"] and codec != "hevc":
        # Le H.264 8 bits délaverait une vidéo HDR (iPhone…) : on garde HEVC 10 bits.
        codec = "hevc"
        note = "Vidéo HDR : gardée en HEVC 10 bits pour préserver les couleurs"

    total = target * 8 * 0.97 / dur  # bits/s, 3 % de marge pour le conteneur
    a_codec, a_br = facts["audio"], facts["audioBitrate"]
    if not a_codec:
        audio_args, audio_br = ["-an"], 0
    elif a_codec == "aac" and a_br and a_br <= 0.15 * total:
        audio_args, audio_br = ["-c:a", "copy"], a_br
    else:
        audio_br = 160_000 if total > 3_000_000 else 128_000 if total > 900_000 else 96_000 if total > 300_000 else 64_000
        audio_args = ["-c:a", "aac", "-b:a", str(audio_br)]
    vbr = int(max(80_000, total - audio_br))

    pixels = facts["width"] * facts["height"]
    heavy = pixels > 2_100_000 or dur > 600  # au-delà du 1080p ou de 10 min : réglage plus rapide
    vf = _scale_filter(max_side)
    tag = ["-tag:v", "hvc1"] if out.lower().endswith((".mp4", ".mov", ".m4v")) else []  # lisible par QuickTime
    tmp = tempfile.mkdtemp(prefix="kotak-2p-")
    try:
        if codec == "hevc":
            preset = "fast" if heavy else "medium"
            pix = "yuv420p10le" if (facts["hdr"] or facts["tenBit"]) else "yuv420p"
            v = facts["_v"]
            color = []
            if facts["hdr"]:
                color = ["colorprim=%s" % (v.get("color_primaries") or "bt2020"),
                         "transfer=%s" % v.get("color_transfer"),
                         "colormatrix=%s" % (v.get("color_space") or "bt2020nc"),
                         "hdr-opt=1", "repeat-headers=1"]

            def venc(pass_no, rate):
                params = ["pass=%d" % pass_no, "stats=x265.log", "log-level=error"] + (["no-slow-firstpass=1"] if pass_no == 1 else []) + color
                return ["-c:v", "libx265", "-preset", preset, "-b:v", str(rate), "-pix_fmt", pix] + tag + ["-x265-params", ":".join(params)]
        else:
            preset = "medium" if heavy else "slow"

            def venc(pass_no, rate):
                return ["-c:v", "libx264", "-preset", preset, "-b:v", str(rate), "-pass", str(pass_no), "-passlogfile", "x264",
                        "-pix_fmt", "yuv420p", "-profile:v", "high"]

        inp = ["-i", os.path.abspath(src), "-map", "0:v:0", "-vf", vf]
        run_ffmpeg(job_id, inp + venc(1, vbr) + ["-an", "-f", "null", os.devnull], dur, "Analyse (passe 1/2)",
                   span=(span[0], span[1] * 0.35), cwd=tmp)
        meta = ["-map_metadata", "-1"] if strip else ["-map_metadata", "0"]
        fast = ["-movflags", "+faststart"] if out.lower().endswith((".mp4", ".mov", ".m4v")) else []
        dest = os.path.abspath(out)
        for attempt in (1, 2, 3):
            run_ffmpeg(job_id, inp + ["-map", "0:a:0?"] + venc(2, vbr) + audio_args + meta + fast + [dest], dur,
                       "Compression (passe 2/2)" if attempt == 1 else "Ajustement du poids",
                       span=(span[0] + span[1] * 0.35, span[1] * 0.65), cwd=tmp)
            size = os.path.getsize(dest)
            if size <= target * 1.01 or attempt == 3:
                break
            # Au-dessus de la cible (images très granuleuses) : 2e passe refaite avec un débit corrigé.
            vbr = int(max(60_000, vbr * (target / size) * 0.96))
        return note
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# Fichiers glissés dans le panneau : envoyés par morceaux, gardés le temps de la session.
_uploads = {}  # jeton -> {path, dir, name}
_uploads_lock = threading.Lock()


def cmd_upload_begin(msg):
    name = safe_name(os.path.basename(msg.get("name") or "video.mp4"))
    d = tempfile.mkdtemp(prefix="kotak-up-")
    path = os.path.join(d, name)
    open(path, "wb").close()
    token = os.path.basename(d)
    with _uploads_lock:
        _uploads[token] = {"path": path, "dir": d, "name": name}
    return {"upload": token}


def _upload(token):
    with _uploads_lock:
        up = _uploads.get(token or "")
    if not up:
        raise RuntimeError("Fichier introuvable : redépose la vidéo")
    return up


def cmd_upload_chunk(msg):
    up = _upload(msg.get("upload"))
    with open(up["path"], "ab") as f:
        f.write(base64.b64decode(msg.get("data") or ""))
    return {"size": os.path.getsize(up["path"])}


def cmd_video_info(msg):
    info = video_facts(_upload(msg.get("upload"))["path"])
    info.pop("_v", None)
    return info


def cmd_discard(msg):
    with _uploads_lock:
        up = _uploads.pop(msg.get("upload") or "", None)
    if up:
        shutil.rmtree(up["dir"], ignore_errors=True)
    return {}


def size_label(n):
    # Même unité que le système : Finder compte 1 Mo = 1 000 000 octets, l'Explorateur Windows 1 048 576.
    mb = n / (1024 * 1024 if WINDOWS else 1_000_000)
    return ("%.1f Mo" % mb).replace(".", ",")


def cmd_compress(msg):
    """Compresse une vidéo déposée dans le panneau ; le résultat va dans le dossier Kotak."""
    job_id = msg["id"]
    try:
        up = _upload(msg.get("upload"))
        stem = safe_name(os.path.splitext(up["name"])[0])
        tmp_out = os.path.join(up["dir"], "kotak-out.mp4")
        note = compress_video(job_id, up["path"], tmp_out, int(msg["target"]), msg.get("codec", "h264"),
                              int(msg.get("maxSide") or 0), strip=True)
        size = os.path.getsize(tmp_out)
        dest = unique_path(download_dir(), "%s (%s).mp4" % (stem, size_label(size)))
        shutil.move(tmp_out, dest)
        send({"id": job_id, "type": "done", "file": dest, "size": size, "note": note})
    finally:
        _jobs.pop(job_id, None)


def cmd_read_file(msg):
    send_file(msg["id"], msg["file"])


SIMPLE = {"status": cmd_status, "probe": cmd_probe, "choose_dir": cmd_choose_dir, "reveal": cmd_reveal, "open": cmd_open, "cancel": cmd_cancel,
          "upload_begin": cmd_upload_begin, "upload_chunk": cmd_upload_chunk, "video_info": cmd_video_info, "discard": cmd_discard}
STREAMING = {"download": cmd_download, "frame": cmd_frame, "read_file": cmd_read_file, "compress": cmd_compress}


def handle(msg):
    msg_id = msg.get("id")
    cmd = msg.get("cmd")
    try:
        if cmd in SIMPLE:
            send({"id": msg_id, "type": "result", "data": SIMPLE[cmd](msg)})
        elif cmd in STREAMING:
            STREAMING[cmd](msg)
        else:
            raise RuntimeError("Commande inconnue : %s" % cmd)
    except Exception as e:  # noqa: BLE001 — tout est renvoyé au panneau
        log("erreur", cmd, repr(e))
        send({"id": msg_id, "type": "error", "message": str(e)})


def main():
    threads = []
    while True:
        msg = read_message()
        if msg is None:
            break
        if msg.get("cmd") in ("status", "cancel", "reveal", "open"):
            handle(msg)
        else:
            th = threading.Thread(target=handle, args=(msg,))
            th.start()
            threads.append(th)
    # Panneau fermé : on laisse finir les téléchargements en cours avant de quitter.
    for th in threads:
        th.join()
    with _uploads_lock:
        for up in _uploads.values():
            shutil.rmtree(up["dir"], ignore_errors=True)


if __name__ == "__main__":
    main()
