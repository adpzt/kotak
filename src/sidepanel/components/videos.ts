// Vidéos déposées dans Convertir : compression vers un poids choisi (en % ou en Mo),
// en gardant le maximum de qualité (encodage en deux passes par le moteur local ffmpeg).
import { h, icon } from '../dom';
import { toast } from './toast';
import { store } from '../store';
import { engine, engineStatus, type JobEvent, type VideoInfo } from '../../lib/engine';
import { MB, fmtClock, formatMB, tightSuggestion } from '../../lib/video';

interface VideoSettings {
  mode: 'percent' | 'target';
  percent: number;
  targetMB: number;
  codec: 'h264' | 'hevc';
  maxSide: number;
}

const KEY = 'kotak.video';
const DEFAULTS: VideoSettings = { mode: 'percent', percent: 30, targetMB: 25, codec: 'h264', maxSide: 0 };

interface Video {
  id: number;
  file: File;
  name: string;
  thumb: string | null;
  upload: string | null;
  info: VideoInfo | null;
  state: 'reading' | 'ready' | 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  readRatio: number;
  event: JobEvent;
  requestId: string | null;
  result: { file: string; size: number; note?: string } | null;
  error: string | null;
  el?: HTMLElement;
}

let settings: VideoSettings = { ...DEFAULTS };
const videos: Video[] = [];
let nextId = 1;
let outDir = '';
let rerender: () => void = () => undefined;

/** Image de la vidéo (vers 1 s) pour la vignette ; null si le navigateur ne sait pas la lire (ProRes…). */
function thumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let settled = false;
    const finish = (r: string | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      resolve(r);
    };
    v.muted = true;
    v.preload = 'auto';
    v.onloadeddata = () => {
      v.currentTime = Math.min(1, (v.duration || 0) / 3);
    };
    v.onseeked = () => {
      try {
        const k = 120 / Math.max(v.videoWidth, v.videoHeight, 1);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * k));
        c.height = Math.max(1, Math.round(v.videoHeight * k));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', 0.75));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 6000);
    v.src = url;
  });
}

/** Poids visé pour cette vidéo (octets). */
function targetFor(v: Video): number {
  const size = v.info?.size ?? v.file.size;
  return settings.mode === 'percent' ? Math.round(size * (1 - settings.percent / 100)) : Math.round(settings.targetMB * MB);
}

function alreadyUnder(v: Video): boolean {
  return settings.mode === 'target' && targetFor(v) >= (v.info?.size ?? v.file.size) * 0.98;
}

export async function addVideos(files: File[]) {
  if (!files.length) return;
  const status = await engineStatus();
  if (!status) {
    toast("La compression vidéo passe par le moteur Kotak (ffmpeg). Installe-le avec la commande indiquée dans l'onglet Lien.", 'error', 9000);
    return;
  }
  outDir = status.dir;
  for (const file of files) {
    const v: Video = {
      id: nextId++,
      file,
      name: file.name || 'video.mp4',
      thumb: null,
      upload: null,
      info: null,
      state: 'reading',
      readRatio: 0,
      event: { type: 'stage' },
      requestId: null,
      result: null,
      error: null,
    };
    videos.push(v);
    rerender();
    thumbnail(file).then((t) => {
      v.thumb = t;
      renderRow(v);
    });
    try {
      v.upload = await engine.upload(file, v.name, (r) => {
        v.readRatio = r;
        renderRow(v);
      });
      v.info = await engine.videoInfo(v.upload);
      v.state = 'ready';
    } catch (e) {
      v.state = 'error';
      v.error = e instanceof Error ? e.message : String(e);
    }
    rerender();
  }
}

// ---------- File d'attente : une compression à la fois (ffmpeg occupe déjà tous les cœurs) ----------
let running = false;

async function pump() {
  if (running) return;
  const v = videos.find((x) => x.state === 'queued');
  if (!v || !v.upload) return;
  running = true;
  v.state = 'running';
  v.event = { type: 'stage', stage: 'Préparation', percent: 0 };
  v.result = null;
  v.error = null;
  renderRow(v);
  const req = engine.compress({ upload: v.upload, target: targetFor(v), codec: settings.codec, maxSide: settings.maxSide }, (e) => {
    v.event = { ...v.event, ...e };
    renderRow(v);
  });
  v.requestId = req.id;
  try {
    const done = await req.promise;
    v.state = 'done';
    v.result = { file: done.file!, size: done.size ?? 0, note: done.note };
    toast(`Compressée : ${v.name.slice(0, 40)} → ${formatMB(v.result.size)}`, 'success');
  } catch (e) {
    v.state = (v.state as Video['state']) === 'cancelled' ? 'cancelled' : 'error';
    v.error = e instanceof Error ? e.message : String(e);
  }
  running = false;
  rerender();
  pump();
}

function enqueue(list: Video[]) {
  let skipped = 0;
  for (const v of list) {
    if (alreadyUnder(v)) {
      skipped++;
      continue;
    }
    v.state = 'queued';
  }
  if (skipped) toast(`${skipped > 1 ? `${skipped} vidéos déjà` : 'Vidéo déjà'} sous ${formatMB(settings.targetMB * MB)} : rien à faire`, 'info');
  rerender();
  pump();
}

function remove(v: Video) {
  const i = videos.indexOf(v);
  if (i < 0) return;
  videos.splice(i, 1);
  if (v.upload) engine.discard(v.upload);
  v.el?.remove();
  rerender();
}

// ---------- Rendu d'une ligne ----------
function renderRow(v: Video) {
  if (!v.el) return;
  const info = v.info;
  const size = info?.size ?? v.file.size;
  const actions: Node[] = [];
  const btn = (name: Parameters<typeof icon>[0], title: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title }, icon(name, 13));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  if (v.state === 'running' || v.state === 'queued') {
    actions.push(btn('stop', 'Annuler', () => {
      if (v.state === 'queued') {
        v.state = 'ready';
        return rerender();
      }
      v.state = 'cancelled';
      if (v.requestId) engine.cancel(v.requestId).catch(() => undefined);
    }));
  } else {
    if (v.state === 'done' && v.result) {
      actions.push(btn('folder', 'Afficher dans le Finder', () => engine.reveal(v.result!.file)));
      actions.push(btn('play', 'Ouvrir', () => engine.open(v.result!.file)));
      actions.push(btn('refresh', 'Refaire avec les réglages actuels', () => enqueue([v])));
    }
    if (v.state !== 'reading') actions.push(btn('x', 'Retirer', () => remove(v)));
  }

  const meta = info ? [`${info.width}×${info.height}`, fmtClock(info.duration), info.hdr ? 'HDR' : '', info.codec.toUpperCase()].filter(Boolean).join(' · ') : '';
  let line: (Node | null)[];
  let pct = 0;
  if (v.state === 'reading') {
    pct = v.readRatio * 100;
    line = [h('span', { class: 'muted' }, `${formatMB(size)} · lecture ${Math.round(pct)} %`)];
  } else if (v.state === 'error') {
    line = [h('span', { class: 'vrow__err' }, v.error ?? 'Erreur')];
  } else if (v.state === 'done' && v.result) {
    pct = 100;
    const saved = Math.round((1 - v.result.size / size) * 100);
    line = [
      h('span', { class: 'muted' }, formatMB(size)),
      h('span', { class: 'arrow' }, '→'),
      h('strong', {}, formatMB(v.result.size)),
      h('span', { class: `pill pill--sm ${saved >= 0 ? 'pill--good' : 'pill--bad'}` }, saved >= 0 ? `−${saved} %` : `+${-saved} %`),
    ];
  } else if (v.state === 'running') {
    pct = v.event.percent ?? 0;
    line = [h('span', { class: 'muted' }, [v.event.stage, `${Math.round(pct)} %`].filter(Boolean).join(' · '))];
  } else {
    const t = targetFor(v);
    line = alreadyUnder(v)
      ? [h('span', { class: 'muted' }, `${formatMB(size)} · déjà sous ${formatMB(t)}`)]
      : [
          h('span', { class: 'muted' }, formatMB(size)),
          h('span', { class: 'arrow' }, '→'),
          h('span', {}, `≈ ${formatMB(t)}`),
          v.state === 'queued' ? h('span', { class: 'muted' }, '· en attente') : v.state === 'cancelled' ? h('span', { class: 'muted' }, '· annulée') : null,
        ];
  }

  const notes: Node[] = [];
  if (v.state === 'done' && v.result?.note) notes.push(h('div', { class: 'vrow__note' }, v.result.note));
  if (info && v.state !== 'done' && v.state !== 'running' && !alreadyUnder(v)) {
    const codec = info.hdr ? 'hevc' : settings.codec;
    const tip = tightSuggestion(targetFor(v), info.duration, info.width, info.height, info.fps, codec, settings.maxSide);
    if (tip) notes.push(h('div', { class: 'vrow__note vrow__note--warn' }, icon('alert', 12), ` Poids serré pour cette définition : passe en ${tip}p dans « Dimensions » pour une image plus nette.`));
    else if (info.hdr && settings.codec === 'h264') notes.push(h('div', { class: 'vrow__note' }, 'Vidéo HDR : elle restera en HEVC 10 bits pour garder ses couleurs.'));
  }

  const showBar = v.state === 'reading' || v.state === 'running' || v.state === 'done';
  v.el.className = `vrow job--${v.state === 'cancelled' ? 'error' : v.state}`;
  v.el.replaceChildren(
    h(
      'div',
      { class: 'vrow__main' },
      h('div', { class: 'row__thumb-wrap' }, v.thumb ? h('img', { class: 'row__thumb', src: v.thumb, alt: '' }) : h('div', { class: 'row__thumb vrow__ph' }, icon('film', 18))),
      h(
        'div',
        { class: 'row__body' },
        h('div', { class: 'row__name', title: v.name }, v.name),
        meta ? h('div', { class: 'vrow__meta muted' }, meta) : null,
        h('div', { class: 'row__info' }, line),
      ),
      h('div', { class: 'job__actions' }, ...actions),
    ),
    ...[showBar ? h('div', { class: 'job__bar' }, h('div', { style: `width:${pct}%` })) : null, ...notes].filter((n): n is HTMLElement => !!n),
  );
}

// ---------- Montage ----------
export async function mountVideos(root: HTMLElement) {
  try {
    settings = { ...DEFAULTS, ...((await chrome.storage.local.get(KEY))[KEY] as Partial<VideoSettings> | undefined) };
  } catch {
    /* valeurs par défaut */
  }
  const save = () => chrome.storage.local.set({ [KEY]: settings }).catch(() => undefined);
  const set = (fn: (s: VideoSettings) => void) => {
    fn(settings);
    save();
    rerender();
  };

  const count = h('span', { class: 'section__count' });
  const list = h('div', { class: 'vlist' });

  const seg = <T extends string | number>(items: [T, string][], get: () => T, pick: (v: T) => void) => {
    const buttons = items.map(([v, l]) => h('button', { type: 'button', class: 'seg__btn', onclick: () => set(() => pick(v)) }, l));
    return { el: h('div', { class: 'seg' }, buttons), sync: () => buttons.forEach((b, i) => b.classList.toggle('is-on', items[i][0] === get())) };
  };
  const field = (label: string, ...children: (Node | null)[]) => h('div', { class: 'field' }, h('div', { class: 'field__label' }, h('span', {}, label)), ...children);

  const mode = seg<VideoSettings['mode']>([['percent', 'Compression %'], ['target', 'Poids cible']], () => settings.mode, (v) => (settings.mode = v));

  const slider = h('input', { type: 'range', min: 5, max: 90, step: 1, class: 'range', 'aria-label': 'Compression vidéo' });
  slider.addEventListener('input', () => {
    settings.percent = Number(slider.value);
    save();
    rerender();
  });
  const sliderValue = h('span', { class: 'range__value' });
  const sliderHint = h('span', { class: 'field__hint' });
  const percentBlock = field('Réduction du poids', h('div', { class: 'range-wrap' }, slider, sliderValue), sliderHint);

  const targetInput = h('input', { type: 'number', min: 0.1, step: 0.5, class: 'input input--num', 'aria-label': 'Poids cible en Mo' });
  targetInput.addEventListener('input', () => {
    const v = Number(targetInput.value.replace(',', '.'));
    if (v > 0) {
      settings.targetMB = v;
      save();
      rerender();
    }
  });
  const targetChips = h('div', { class: 'chips' },
    [8, 10, 16, 20, 25, 50, 100].map((v) => h('button', { type: 'button', class: 'chip', onclick: () => set((s) => (s.targetMB = v)) }, `${v} Mo`)),
  );
  const targetBlock = field('Poids maximum', h('div', { class: 'stack' }, h('div', { class: 'input-unit' }, targetInput, h('span', {}, 'Mo')), targetChips), h('span', { class: 'field__hint' }, 'meilleure qualité possible sous ce poids (par vidéo)'));

  const codec = seg<VideoSettings['codec']>([['h264', 'H.264'], ['hevc', 'HEVC (H.265)']], () => settings.codec, (v) => (settings.codec = v));
  const codecHint = h('span', { class: 'field__hint' });
  const sizes = seg<number>([[0, 'Origine'], [2160, '4K'], [1080, '1080p'], [720, '720p']], () => settings.maxSide, (v) => (settings.maxSide = v));
  const sizesHint = h('span', { class: 'field__hint' }, 'réduit seulement, jamais agrandi');

  const goBtn = h('button', { type: 'button', class: 'btn btn--primary media-go' }, icon('film', 16), h('span', {}, 'Compresser'));
  goBtn.addEventListener('click', () => enqueue(videos.filter((v) => v.state === 'ready' || v.state === 'error' || v.state === 'cancelled')));
  const where = h('p', { class: 'note' });

  root.append(
    h('div', { class: 'section__head' }, h('h2', { class: 'section__title' }, 'Vidéos'), count),
    list,
    h('div', { class: 'stack vsettings' },
      mode.el,
      percentBlock,
      targetBlock,
      field('Codec', codec.el, codecHint),
      field('Dimensions', sizes.el, sizesHint),
    ),
    goBtn,
    where,
  );

  const imageSettings = [document.getElementById('settings'), document.getElementById('preset-form')];

  rerender = () => {
    root.hidden = videos.length === 0;
    // Que des vidéos : les réglages d'image n'ont rien à faire à l'écran.
    const onlyVideos = videos.length > 0 && store.items.length === 0 && store.importing === 0;
    for (const el of imageSettings) if (el) el.hidden = onlyVideos;
    count.textContent = String(videos.length);
    for (const v of videos) {
      if (!v.el) v.el = h('div', { class: 'vrow' });
      list.append(v.el);
      renderRow(v);
    }
    mode.sync();
    codec.sync();
    sizes.sync();
    percentBlock.hidden = settings.mode !== 'percent';
    targetBlock.hidden = settings.mode !== 'target';
    if (document.activeElement !== slider) slider.value = String(settings.percent);
    slider.style.setProperty('--fill', `${((settings.percent - 5) / 85) * 100}%`);
    sliderValue.textContent = `${settings.percent} %`;
    const total = videos.reduce((a, v) => a + (v.info?.size ?? v.file.size), 0);
    sliderHint.textContent = total ? `${formatMB(total)} → ≈ ${formatMB(total * (1 - settings.percent / 100))}` : '';
    if (document.activeElement !== targetInput) targetInput.value = String(settings.targetMB);
    codecHint.textContent = settings.codec === 'h264' ? 'lisible partout (WhatsApp, Premiere, Keynote, réseaux)' : 'plus net à poids égal, lisible sur Apple et logiciels récents';

    const todo = videos.filter((v) => v.state === 'ready' || v.state === 'error' || v.state === 'cancelled');
    const busy = videos.some((v) => v.state === 'running' || v.state === 'queued');
    const reading = videos.some((v) => v.state === 'reading');
    goBtn.disabled = todo.length === 0;
    (goBtn.lastElementChild as HTMLElement).textContent = busy && !todo.length
      ? 'Compression en cours…'
      : reading && !todo.length
        ? 'Lecture de la vidéo…'
        : todo.length > 1
        ? `Compresser les ${todo.length} vidéos`
        : 'Compresser';
    where.textContent = outDir ? `Enregistrées dans ${outDir.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~')} (dossier modifiable dans l'onglet Lien)` : '';
  };
  store.on('items', () => rerender());
  rerender();
}
