import { h, icon } from '../dom';
import { store } from '../store';
import { toast } from './toast';
import { INBOX_KEY, type InboxEntry } from '../../lib/inbox';
import { ACCEPTED_EXT } from '../../core/decoders';
import { currentModule, showModule } from '../nav';
import { addVideos } from './videos';
import { looksLikeVideo } from '../../lib/video';

const IMAGE_EXT = ACCEPTED_EXT;
const ACCEPT_LIST = '.svg,.svgz,.ico,.heic,.heif,.hif,.tif,.tiff,.psd,.psb,.jxl,.qoi,.tga,.pdf,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.dng,.raf,.orf,.rw2,.rwl,.pef,.ptx,.srw,.x3f,.3fr,.fff,.iiq,.mos,.mef,.mrw,.erf,.kdc,.dcr';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

type NamedBlob = { blob: Blob; name: string };

function looksLikeImage(f: File): boolean {
  return f.type.startsWith('image/') || f.type === 'application/pdf' || IMAGE_EXT.test(f.name);
}

/** Vidéos vers la compression vidéo, le reste vers le convertisseur d'images. */
function addFiles(files: File[]) {
  const vids = files.filter(looksLikeVideo);
  const imgs = files.filter((f) => !looksLikeVideo(f) && looksLikeImage(f));
  if (vids.length) {
    if (currentModule() !== 'convert') showModule('convert');
    addVideos(vids);
  }
  return imgs;
}

/** Les fichiers vont toujours au convertisseur (qu'on affiche s'il ne l'est pas). */
async function addAndReport(files: NamedBlob[]) {
  if (!files.length) return;
  if (currentModule() !== 'convert') showModule('convert');
  const errors = await store.addFiles(files);
  if (errors.length) {
    const more = errors.length > 2 ? ` (+${errors.length - 2})` : '';
    toast(`Ignoré : ${errors.slice(0, 2).join(' · ')}${more}`, 'error', 6000);
  }
}

// ---------- Glisser-déposer (dossiers compris) ----------

function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((res) => (entry as FileSystemFileEntry).file((f) => res([f]), () => res([])));
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return new Promise((res) => {
      const all: FileSystemEntry[] = [];
      const next = () =>
        reader.readEntries(async (batch) => {
          if (batch.length) {
            all.push(...batch);
            next();
          } else {
            const nested = await Promise.all(all.map(readEntry));
            res(nested.flat());
          }
        }, () => res([]));
      next();
    });
  }
  return Promise.resolve([]);
}

async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length) return (await Promise.all(entries.map(readEntry))).flat();
  return Array.from(dt.files);
}

/** Image glissée depuis une page web : on récupère son URL. */
function urlFromDataTransfer(dt: DataTransfer): string | null {
  const html = dt.getData('text/html');
  const m = html && /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  if (m) return m[1].replace(/&amp;/g, '&');
  const uri = dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
  return uri?.trim() || null;
}

// ---------- Images depuis une URL (clic droit, glisser depuis le web) ----------

function nameFromUrl(url: string, type: string): string {
  let stem = 'image-web';
  try {
    if (!url.startsWith('data:')) {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
      if (last) stem = last;
    }
  } catch {
    /* URL exotique : nom par défaut */
  }
  if (IMAGE_EXT.test(stem)) return stem;
  const ext = MIME_EXT[type] ?? 'png';
  return `${stem.replace(/\.[^.]*$/, '')}.${ext}`;
}

export async function addFromUrl(url: string) {
  try {
    if (url.startsWith('blob:')) throw new Error("image protégée par la page (blob)");
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') && blob.type !== 'application/pdf' && !IMAGE_EXT.test(url)) throw new Error("ce n'est pas une image");
    await addAndReport([{ blob, name: nameFromUrl(url, blob.type) }]);
  } catch (e) {
    toast(`Impossible de récupérer l'image : ${e instanceof Error ? e.message : e}`, 'error', 6000);
  }
}

let draining = false;

async function drainInbox() {
  if (!chrome?.storage?.session || draining) return;
  draining = true;
  try {
    const r = await chrome.storage.session.get(INBOX_KEY);
    const inbox = (r[INBOX_KEY] as InboxEntry[] | undefined) ?? [];
    if (!inbox.length) return;
    await chrome.storage.session.set({ [INBOX_KEY]: [] });
    for (const entry of inbox) await addFromUrl(entry.url);
  } finally {
    draining = false;
  }
  // Des images ont pu arriver pendant le traitement.
  const again = await chrome.storage.session.get(INBOX_KEY);
  if ((again[INBOX_KEY] as InboxEntry[] | undefined)?.length) drainInbox();
}

// ---------- Montage ----------

export function mountDropzone(root: HTMLElement) {
  const input = h('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf,video/*,.mkv,.mts,.m2ts,.mxf,' + ACCEPT_LIST, hidden: true });
  input.addEventListener('change', () => {
    const files = addFiles(Array.from(input.files ?? []));
    addAndReport(files.map((f) => ({ blob: f, name: f.name })));
    input.value = '';
  });
  const browse = () => input.click();

  const hero = h(
    'button',
    { class: 'drop-hero', type: 'button', onclick: browse },
    h('span', { class: 'drop-hero__icon' }, icon('upload', 26)),
    h('span', { class: 'drop-hero__title' }, 'Glisse tes images ou vidéos ici'),
    h('span', { class: 'drop-hero__sub' }, 'ou ', h('u', {}, 'parcours'), ', colle avec ', h('kbd', {}, '⌘V'), ', ou clic droit sur une image du web'),
    h('span', { class: 'drop-hero__formats' }, 'JPG · PNG · WebP · AVIF · GIF · SVG · HEIC · TIFF · PSD · PDF · RAW · JPEG XL · BMP · ICO · TGA · QOI'),
    h('span', { class: 'drop-hero__formats' }, 'Vidéos à compresser : MP4 · MOV · MKV · WebM · AVI…'),
  );

  const compact = h(
    'button',
    { class: 'drop-compact', type: 'button', onclick: browse },
    icon('plus', 15),
    h('span', {}, 'Ajouter des images ou vidéos'),
    h('span', { class: 'drop-compact__hint' }, 'ou glisser / ⌘V'),
  );

  const importing = h('div', { class: 'importing' }, h('span', { class: 'spinner spinner--sm' }), h('span', { class: 'importing__label' }));
  root.append(input, hero, compact, importing);

  const render = () => {
    const empty = store.items.length === 0 && store.importing === 0;
    hero.hidden = !empty;
    compact.hidden = empty;
    importing.hidden = store.importing === 0;
    (importing.lastElementChild as HTMLElement).textContent = `Lecture${store.importing > 1 ? ` (${store.importing} fichiers)` : ''} — ${store.importLabel}`;
  };
  store.on('items', render);
  render();

  // Dépôt n'importe où dans le panneau.
  const overlay = h('div', { class: 'drop-overlay' }, h('div', { class: 'drop-overlay__inner' }, icon('upload', 28), h('span', {}, 'Dépose pour ajouter')));
  document.body.append(overlay);
  let depth = 0;
  const hasPayload = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes('Files') || types.includes('text/uri-list');
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasPayload(e)) return;
    depth++;
    overlay.classList.add('is-active');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('is-active');
  });
  document.addEventListener('dragover', (e) => {
    if (hasPayload(e)) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('is-active');
    const dt = e.dataTransfer;
    if (!dt) return;
    const all = await filesFromDataTransfer(dt);
    const files = addFiles(all);
    if (all.some(looksLikeVideo) && !files.length) return;
    if (files.length) {
      addAndReport(files.map((f) => ({ blob: f, name: f.name })));
      return;
    }
    const url = urlFromDataTransfer(dt);
    if (url) addFromUrl(url);
  });

  // Coller depuis le presse-papier.
  document.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const pasted = Array.from(e.clipboardData?.files ?? []);
    const files = addFiles(pasted);
    if (pasted.some(looksLikeVideo)) {
      e.preventDefault();
      if (!files.length) return;
    }
    if (files.length) {
      e.preventDefault();
      addAndReport(
        files.map((f, i) => ({
          blob: f,
          name: f.name && f.name !== 'image.png' ? f.name : `presse-papier-${Date.now()}${i ? `-${i}` : ''}.${MIME_EXT[f.type] ?? 'png'}`,
        })),
      );
      return;
    }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (text && /^(https?:|data:image\/)/i.test(text)) {
      e.preventDefault();
      addFromUrl(text);
    }
  });

  // Images envoyées par le menu clic droit.
  drainInbox();
  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'session' && (changes[INBOX_KEY]?.newValue as InboxEntry[] | undefined)?.length) drainInbox();
  });
}
