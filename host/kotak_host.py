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
    }


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


def spawn(job_id, args):
    proc = subprocess.Popen(
        args,
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


def run_ffmpeg(job_id, args, duration, stage):
    """Lance ffmpeg en suivant son avancement (-progress)."""
    send({"id": job_id, "type": "stage", "stage": stage})
    proc = spawn(job_id, [FFMPEG, "-hide_banner", "-nostats", "-progress", "pipe:1", "-y"] + args)
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
                send({"id": job_id, "type": "progress", "percent": max(0.0, min(100.0, us / 1e6 / duration * 100)), "stage": stage})
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
            if codec == "original":
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


def cmd_read_file(msg):
    send_file(msg["id"], msg["file"])


SIMPLE = {"status": cmd_status, "probe": cmd_probe, "choose_dir": cmd_choose_dir, "reveal": cmd_reveal, "open": cmd_open, "cancel": cmd_cancel}
STREAMING = {"download": cmd_download, "frame": cmd_frame, "read_file": cmd_read_file}


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


if __name__ == "__main__":
    main()
