// Calculs vidéo partagés par Convertir (vidéos déposées) et Lien (estimation avant téléchargement).
import type { DownloadOptions, ProbeInfo } from './engine';

export const WINDOWS = /win/i.test((navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.platform);

/** 1 Mo tel que l'affiche le système : Finder (Mac) compte en 1 000 000 octets, l'Explorateur Windows en 1 048 576. */
export const MB = WINDOWS ? 1024 * 1024 : 1_000_000;

export function formatMB(bytes: number): string {
  const mb = bytes / MB;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / (MB / 1000)))} Ko`;
  return `${mb.toFixed(mb < 100 ? 1 : 0).replace('.', ',')} Mo`;
}

export const VIDEO_EXT = /\.(mp4|m4v|mov|qt|mkv|webm|avi|wmv|flv|mts|m2ts|ts|mpg|mpeg|3gp|mxf|ogv|hevc)$/i;

export function looksLikeVideo(f: File): boolean {
  return f.type.startsWith('video/') || VIDEO_EXT.test(f.name);
}

/** Débit (bit/s) utilisé par le moteur pour les conversions H.264 / HEVC (miroir de video_bitrate dans kotak_host.py). */
export function engineBitrate(height: number, codec: 'h264' | 'hevc'): number {
  const mbps = height >= 4000 ? 90 : height >= 2000 ? 45 : height >= 1400 ? 24 : height >= 1000 ? 12 : height >= 700 ? 7 : 4;
  return (codec === 'hevc' ? Math.max(3, Math.floor(mbps * 0.6)) : mbps) * 1_000_000;
}

/**
 * Poids approximatif du fichier téléchargé (octets), avant toute compression.
 * null si le site ne donne pas assez d'informations.
 */
export function estimateDownload(info: ProbeInfo, opts: Omit<DownloadOptions, 'url'>, clipSeconds: number | null): number | null {
  const dur = info.duration ?? 0;
  const ratio = clipSeconds && dur ? Math.min(1, clipSeconds / dur) : 1;
  const span = clipSeconds ?? dur;
  if (opts.mode === 'image') return null;
  if (opts.mode === 'audio') {
    if (!span) return null;
    const pcm = 48_000 * 2 * (opts.depth / 8);
    const bps: Record<DownloadOptions['audio'], number> = {
      mp3: (opts.bitrate * 1000) / 8,
      wav: pcm,
      aiff: pcm,
      m4a: 256_000 / 8,
      flac: pcm * 0.6,
      opus: 192_000 / 8,
    };
    return bps[opts.audio] * span;
  }
  const f = info.formats;
  // Comme yt-dlp : les flux que le site met en retrait (HLS « premium » de YouTube…) passent après les autres.
  const all = f?.video ?? [];
  const bestPref = Math.max(...all.map((v) => v.pref ?? 0));
  const preferred = all.filter((v) => (v.pref ?? 0) === bestPref && !v.hls);
  const candidates = (preferred.length ? preferred : all).filter((v) => !opts.quality || v.h <= opts.quality);
  if (!candidates.length) return null;
  const top = Math.max(...candidates.map((v) => v.h));
  const atTop = candidates.filter((v) => v.h === top);
  const wantsH264 = (opts.codec === 'h264' || opts.codec === 'original') && (opts.container === 'mp4' || opts.container === 'mov');
  const h264 = atTop.filter((v) => v.h264);
  const pick = (wantsH264 && h264.length ? h264 : atTop).reduce((a, b) => (b.size > a.size ? b : a));
  const audio = pick.muxed ? 0 : f?.audio?.size ?? 0;
  const audioRate = dur && audio ? audio / dur : 256_000 / 8;
  if (opts.codec === 'original' || (opts.codec === 'h264' && pick.h264)) return (pick.size + audio) * ratio;
  if (!span) return null;
  if (opts.codec === 'prores') return ((147_000_000 * (top / 1080) ** 2) / 8 + 48_000 * 4) * span;
  return (engineBitrate(top, opts.codec) / 8 + audioRate) * span;
}

/** Définition (petit côté) après réduction éventuelle. */
export function outputSize(w: number, h: number, maxSide: number): [number, number] {
  const short = Math.min(w, h);
  if (!maxSide || short <= maxSide) return [w, h];
  const k = maxSide / short;
  return [Math.round(w * k), Math.round(h * k)];
}

/**
 * Poids trop serré pour la définition : bits par pixel et par image sous le seuil où
 * l'image commence à se dégrader visiblement. Renvoie la définition conseillée (petit côté) ou null.
 */
export function tightSuggestion(target: number, duration: number, w: number, h: number, fps: number, codec: 'h264' | 'hevc', maxSide: number): number | null {
  if (!duration || !w || !h) return null;
  const [ow, oh] = outputSize(w, h, maxSide);
  const bpp = (target * 8 * 0.95) / duration / (ow * oh * (fps || 30));
  const floor = codec === 'hevc' ? 0.028 : 0.04;
  if (bpp >= floor) return null;
  const short = Math.min(ow, oh);
  return [1080, 720, 540].find((s) => s < short) ?? null;
}

export function fmtClock(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
