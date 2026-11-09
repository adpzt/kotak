// Client du moteur local Kotak (yt-dlp + ffmpeg sur le Mac), via Native Messaging.
// Le moteur est installé par scripts/install-mac.sh ; l'extension fonctionne sans lui
// (seul le module Médias en dépend).

export const ENGINE_HOST = 'com.kotak.engine';

export interface EngineStatus {
  ytdlp: string;
  ffmpeg: string;
  dir: string;
}

export interface ProbeInfo {
  url: string;
  title: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
  site: string;
  maxHeight: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Poids des flux proposés par le site (estimation avant téléchargement). */
  formats?: {
    video: { h: number; h264: boolean; size: number; muxed: boolean; hls?: boolean; pref?: number }[];
    audio: { size: number; aac: boolean; abr: number } | null;
  };
}

/** Vidéo déposée dans le panneau, analysée par ffprobe. */
export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  codec: string;
  hdr: boolean;
  tenBit: boolean;
  audio: string | null;
  audioBitrate: number;
  size: number;
}

export interface CompressOptions {
  upload: string;
  /** Poids visé, en octets. */
  target: number;
  codec: 'h264' | 'hevc';
  /** Petit côté maximum (0 = taille d'origine). */
  maxSide: number;
}

export interface DownloadOptions {
  url: string;
  mode: 'video' | 'audio' | 'image';
  quality: number; // 0 = maximum
  container: 'mp4' | 'mov' | 'mkv' | 'webm';
  codec: 'original' | 'h264' | 'hevc' | 'prores';
  audio: 'mp3' | 'wav' | 'aiff' | 'm4a' | 'flac' | 'opus';
  bitrate: number;
  depth: 16 | 24;
  start: string;
  end: string;
  cookies: string;
  /** Réduction du poids en % (0 = pas de compression). */
  compress: number;
}

export interface JobEvent {
  type: 'progress' | 'stage' | 'done' | 'error';
  percent?: number;
  speed?: string;
  eta?: string;
  stage?: string;
  file?: string;
  size?: number;
  message?: string;
  note?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onEvent?: (e: JobEvent) => void;
  chunks?: string[];
};

let port: chrome.runtime.Port | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();
let lastError = '';

function connect(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connectNative(ENGINE_HOST);
  p.onMessage.addListener((msg: Omit<JobEvent, 'type'> & { id: string; type: string; data?: unknown; message?: string; seq?: number; chunk?: string; last?: boolean }) => {
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === 'result') {
      pending.delete(msg.id);
      job.resolve(msg.data);
    } else if (msg.type === 'error') {
      pending.delete(msg.id);
      job.onEvent?.({ type: 'error', message: msg.message });
      job.reject(new Error(msg.message || 'Erreur du moteur'));
    } else if (msg.type === 'chunk') {
      // Fichiers renvoyés par morceaux (les messages du moteur sont limités à 1 Mo).
      (job.chunks ??= []).push(msg.chunk ?? '');
      if (msg.last) {
        pending.delete(msg.id);
        const b64 = job.chunks.join('');
        job.resolve(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      }
    } else {
      job.onEvent?.(msg as JobEvent);
      if (msg.type === 'done') {
        pending.delete(msg.id);
        job.resolve(msg);
      }
    }
  });
  p.onDisconnect.addListener(() => {
    lastError = chrome.runtime.lastError?.message ?? 'Moteur arrêté';
    port = null;
    for (const [id, job] of pending) {
      pending.delete(id);
      job.reject(new Error(lastError));
    }
  });
  port = p;
  return p;
}

function request<T>(cmd: string, payload: object = {}, onEvent?: (e: JobEvent) => void): { id: string; promise: Promise<T> } {
  const id = `r${nextId++}`;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent });
    try {
      connect().postMessage({ id, cmd, ...payload });
    } catch (e) {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  return { id, promise };
}

/** null si le moteur n'est pas installé (ou pas autorisé pour cette extension). */
export async function engineStatus(): Promise<EngineStatus | null> {
  try {
    return await Promise.race([
      request<EngineStatus>('status').promise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Délai dépassé')), 8000)),
    ]);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export function engineError(): string {
  return lastError;
}

/** Morceaux de 4 Mo : bien sous la limite des messages vers le moteur, peu d'allers-retours. */
const CHUNK = 4 * 1024 * 1024;

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error ?? new Error('Lecture du fichier impossible'));
    r.readAsDataURL(blob);
  });
}

export const engine = {
  probe: (url: string, cookies: string) => request<ProbeInfo>('probe', { url, cookies }).promise,
  download(opts: DownloadOptions, onEvent: (e: JobEvent) => void) {
    return request<JobEvent>('download', opts, onEvent);
  },
  cancel: (jobId: string) => request('cancel', { job: jobId }).promise,
  reveal: (file: string) => request('reveal', { file }).promise,
  open: (file: string) => request('open', { file }).promise,
  chooseDir: () => request<{ dir: string }>('choose_dir').promise,
  readFile: (file: string) => request<Uint8Array>('read_file', { file }).promise,
  /** Image d'une vidéo en ligne à un instant donné, en pleine résolution (meilleur flux). */
  frame: (url: string, time: number, cookies: string) => request<Uint8Array>('frame', { url, time, cookies }).promise,

  /** Copie un fichier du panneau vers le moteur (par morceaux) ; renvoie son jeton. */
  async upload(file: Blob, name: string, onProgress?: (ratio: number) => void): Promise<string> {
    const { upload } = await request<{ upload: string }>('upload_begin', { name }).promise;
    for (let pos = 0; pos < file.size; pos += CHUNK) {
      const data = await readBase64(file.slice(pos, pos + CHUNK));
      await request('upload_chunk', { upload, data }).promise;
      onProgress?.(Math.min(1, (pos + CHUNK) / file.size));
    }
    return upload;
  },
  videoInfo: (upload: string) => request<VideoInfo>('video_info', { upload }).promise,
  compress(opts: CompressOptions, onEvent: (e: JobEvent) => void) {
    return request<JobEvent>('compress', opts, onEvent);
  },
  discard: (upload: string) => request('discard', { upload }).promise.catch(() => undefined),
};
