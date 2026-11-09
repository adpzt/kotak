// Module Médias : colle un lien (YouTube, TikTok, X, Instagram, Vimeo…) et télécharge
// en vidéo (jusqu'à 4K/8K), audio (MP3, WAV…) ou image, via le moteur local yt-dlp + ffmpeg.
import { h, icon } from '../dom';
import { toast } from '../components/toast';
import { store } from '../store';
import { currentModule, onModuleChange, showModule } from '../nav';
import { engine, engineError, engineStatus, type DownloadOptions, type EngineStatus, type JobEvent, type ProbeInfo } from '../../lib/engine';
import { formatBytes } from '../../lib/files';
import { estimateDownload, formatMB } from '../../lib/video';

type Opts = Omit<DownloadOptions, 'url'> & { compressOn: boolean };

const KEY = 'kotak.media';
const WINDOWS = /win/i.test((navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.platform);
const DEFAULTS: Opts = {
  mode: 'video',
  quality: 0,
  container: 'mp4',
  codec: 'h264',
  audio: 'mp3',
  bitrate: 320,
  depth: 24,
  start: '',
  end: '',
  cookies: '',
  compress: 30,
  compressOn: false,
};

const QUALITIES: [number, string][] = [
  [0, 'Maximum disponible'],
  [4320, '8K (4320p)'],
  [2160, '4K (2160p)'],
  [1440, '1440p'],
  [1080, '1080p (Full HD)'],
  [720, '720p'],
  [480, '480p'],
];

const CODECS: [Opts['codec'], string][] = [
  ['h264', 'H.264 : lisible partout (Premiere, Keynote, QuickTime)'],
  ['original', 'Original : qualité intacte, le plus rapide'],
  ['hevc', 'HEVC (H.265) : plus léger, Apple / Premiere récents'],
  ['prores', 'ProRes 422 : montage (fichiers lourds, .mov)'],
];

const BROWSERS: [string, string][] = [
  ['', 'Aucune (contenus publics)'],
  ['brave', 'Brave'],
  ['chrome', 'Chrome'],
  ['safari', 'Safari'],
  ['firefox', 'Firefox'],
  ['edge', 'Edge'],
  ['arc', 'Arc'],
];

interface Job {
  key: string;
  info: ProbeInfo;
  opts: Opts;
  requestId: string | null;
  state: 'running' | 'done' | 'error' | 'cancelled';
  event: JobEvent;
  file?: string;
  size?: number;
  el?: HTMLElement;
}

function fmtDuration(s: number | null): string {
  if (!s) return '';
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.round(s % 60);
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** « 90 », « 1:30 », « 1:02:03 », « 1m30s », « 90s » -> secondes (null si invalide). */
export function parseTime(raw: string): number | null {
  const v = raw.trim().toLowerCase().replace(',', '.');
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const hms = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(v);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+(hms[1] ?? 0)) * 3600 + (+(hms[2] ?? 0)) * 60 + parseFloat(hms[3] ?? '0');
  const parts = v.split(':');
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
  }
  return null;
}

export function fmtTime(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

/** Moments indiqués dans un lien : ?t=90 / &t=1m30s (partage YouTube), ?start=30&end=45 (lecteur intégré YouTube), #t=90. */
export function timesFromUrl(url: string): { start: number | null; end: number | null } {
  try {
    const u = new URL(url);
    const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = u.searchParams.get(k) ?? hash.get(k);
        if (v) return parseTime(v);
      }
      return null;
    };
    return { start: pick('t', 'start', 'time_continue'), end: pick('end') };
  } catch {
    return { start: null, end: null };
  }
}

/** Injecté dans la page : position de la vidéo principale (en lecture, sinon la plus grande). */
function currentVideoTime(): number | null {
  const videos = Array.from(document.querySelectorAll('video')).filter((v) => v.duration > 0);
  if (!videos.length) return null;
  const score = (v: HTMLVideoElement) => (v.paused ? 0 : 1e9) + v.getBoundingClientRect().width * v.getBoundingClientRect().height;
  return videos.sort((a, b) => score(b) - score(a))[0].currentTime;
}

function qualityLabel(height: number | null): string {
  if (!height) return '';
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return `${height}p`;
}

export async function mountMedia(root: HTMLElement) {
  let opts: Opts = { ...DEFAULTS };
  try {
    opts = { ...DEFAULTS, ...((await chrome.storage.local.get(KEY))[KEY] as Partial<Opts> | undefined), start: '', end: '' };
  } catch {
    /* valeurs par défaut */
  }
  const save = () => chrome.storage.local.set({ [KEY]: { ...opts, start: '', end: '' } }).catch(() => undefined);
  let clipOn = false;
  let status: EngineStatus | null = null;
  let checking = true;
  let analyzed: ProbeInfo[] = [];
  const jobs: Job[] = [];

  // ---------- État du moteur ----------
  const statusBox = h('section', { class: 'card engine' });

  // ---------- Liens ----------
  const links = h('textarea', { class: 'input links', rows: 3, placeholder: 'Colle un ou plusieurs liens (un par ligne)\nYouTube, TikTok, Instagram, X, Vimeo, Facebook, SoundCloud…', spellcheck: false });
  const tabBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, icon('link', 14), "Lien de l'onglet");
  const analyzeBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, icon('refresh', 14), 'Analyser');
  const results = h('div', { class: 'media-results' });
  const linkCard = h('section', { class: 'card' }, h('div', { class: 'section__head' }, h('h2', { class: 'section__title' }, 'Liens')), links, h('div', { class: 'row media-actions' }, tabBtn, h('span', { class: 'spacer' }), analyzeBtn), results);

  tabBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) return toast("L'onglet actuel n'a pas de lien web", 'error');
    links.value = links.value.trim() ? `${links.value.trim()}\n${tab.url}` : tab.url;
    analyze();
  });
  analyzeBtn.addEventListener('click', () => analyze());
  links.addEventListener('paste', () => setTimeout(() => analyze(), 50));

  // ---------- Options ----------
  const seg = <T extends string>(items: [T, string][], get: () => T, set: (v: T) => void) => {
    const buttons = items.map(([v, l]) => h('button', { type: 'button', class: 'seg__btn', onclick: () => {
      set(v);
      save();
      renderOptions();
    } }, l));
    return { el: h('div', { class: 'seg' }, buttons), sync: () => buttons.forEach((b, i) => b.classList.toggle('is-on', items[i][0] === get())) };
  };
  const select = <T extends string | number>(items: [T, string][], get: () => T, set: (v: T) => void, label: string) => {
    const el = h('select', { class: 'input select', 'aria-label': label }, items.map(([v, l]) => h('option', { value: String(v) }, l)));
    el.addEventListener('change', () => {
      const raw = el.value;
      set((typeof items[0][0] === 'number' ? Number(raw) : raw) as T);
      save();
      renderOptions();
    });
    return { el, sync: () => (el.value = String(get())) };
  };
  const field = (label: string, ...children: Node[]) => h('div', { class: 'field' }, h('div', { class: 'field__label' }, h('span', {}, label)), ...children);

  const modeSeg = seg<Opts['mode']>([['video', 'Vidéo'], ['audio', 'Audio'], ['image', 'Miniature']], () => opts.mode, (v) => (opts.mode = v));
  const qualitySel = select<number>(QUALITIES, () => opts.quality, (v) => (opts.quality = v), 'Qualité');
  const containerSeg = seg<Opts['container']>([['mp4', 'MP4'], ['mov', 'MOV'], ['mkv', 'MKV'], ['webm', 'WebM']], () => opts.container, (v) => (opts.container = v));
  const codecSel = select<Opts['codec']>(CODECS, () => opts.codec, (v) => (opts.codec = v), 'Codec');
  const codecNote = h('p', { class: 'field__hint' });
  const audioSeg = seg<Opts['audio']>([['mp3', 'MP3'], ['wav', 'WAV'], ['aiff', 'AIFF'], ['m4a', 'M4A'], ['flac', 'FLAC'], ['opus', 'Opus']], () => opts.audio, (v) => (opts.audio = v));
  const bitrateSel = select<number>([[320, '320 kb/s (max)'], [256, '256 kb/s'], [192, '192 kb/s'], [128, '128 kb/s']], () => opts.bitrate, (v) => (opts.bitrate = v), 'Débit MP3');
  const depthSeg = seg<'16' | '24'>([['16', '16 bits'], ['24', '24 bits']], () => String(opts.depth) as '16' | '24', (v) => (opts.depth = Number(v) as 16 | 24));
  const startInput = h('input', { type: 'text', class: 'input mono', placeholder: '0:00', 'aria-label': 'Début' });
  const endInput = h('input', { type: 'text', class: 'input mono', placeholder: 'fin de la vidéo', 'aria-label': 'Fin' });
  for (const [el, k] of [[startInput, 'start'], [endInput, 'end']] as const) {
    el.addEventListener('input', () => {
      opts[k] = el.value.trim();
      el.classList.toggle('is-invalid', !!opts[k] && parseTime(opts[k]) === null);
      renderOptions();
    });
  }
  const nowBtn = (k: 'start' | 'end') => {
    const b = h('button', { type: 'button', class: 'btn btn--ghost btn--sm clip-now', title: 'Prendre la position actuelle de la vidéo dans l\'onglet' }, '⏱');
    b.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error();
        const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: currentVideoTime });
        const t = res.map((r) => r.result as number | null).find((x) => typeof x === 'number');
        if (typeof t !== 'number') throw new Error();
        opts[k] = fmtTime(t);
        renderOptions();
      } catch {
        toast("Aucune vidéo en lecture dans l'onglet actuel", 'error');
      }
    });
    return b;
  };
  const clipToggle = h('input', { type: 'checkbox' });
  clipToggle.addEventListener('change', () => {
    clipOn = clipToggle.checked;
    renderOptions();
  });
  const clipHint = h('p', { class: 'field__hint' });
  const clipRow = h(
    'div',
    { class: 'stack clip' },
    h('div', { class: 'clip__row' },
      h('label', { class: 'clip__label' }, 'Début'), startInput, nowBtn('start'),
    ),
    h('div', { class: 'clip__row' },
      h('label', { class: 'clip__label' }, 'Fin'), endInput, nowBtn('end'),
    ),
    clipHint,
  );
  const clipBlock = h(
    'div',
    { class: 'field' },
    h('label', { class: 'check' }, clipToggle, h('span', { class: 'check__box' }, icon('check', 12)), h('span', {}, 'Seulement un passage (de tel moment à tel moment)')),
    clipRow,
  );
  const cookiesSel = select<string>(BROWSERS, () => opts.cookies, (v) => (opts.cookies = v), 'Session');
  const dirLabel = h('span', { class: 'mono ellipsis dir-label' });
  const dirBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, icon('folder', 14), 'Changer…');
  dirBtn.addEventListener('click', async () => {
    try {
      const r = await engine.chooseDir();
      if (status) status.dir = r.dir;
      renderStatus();
    } catch {
      /* annulé */
    }
  });

  // Compression (après téléchargement, en deux passes, vers le poids choisi).
  const compressToggle = h('input', { type: 'checkbox' });
  compressToggle.addEventListener('change', () => {
    opts.compressOn = compressToggle.checked;
    save();
    renderOptions();
  });
  const compressSlider = h('input', { type: 'range', min: 5, max: 90, step: 1, class: 'range', 'aria-label': 'Compression' });
  compressSlider.addEventListener('input', () => {
    opts.compress = Number(compressSlider.value);
    save();
    renderOptions();
  });
  const compressValue = h('span', { class: 'range__value' });
  const compressHint = h('p', { class: 'field__hint' });
  const compressDetail = h('div', { class: 'stack' }, h('div', { class: 'range-wrap' }, compressSlider, compressValue), compressHint);
  const compressBlock = h(
    'div',
    { class: 'field' },
    h('label', { class: 'check' }, compressToggle, h('span', { class: 'check__box' }, icon('check', 12)), h('span', {}, 'Compresser la vidéo (meilleure qualité possible pour le poids choisi)')),
    compressDetail,
  );
  const estimateLine = h('p', { class: 'field__hint media-estimate' });

  const videoBlock = h('div', { class: 'stack' }, field('Qualité', qualitySel.el), field('Format', containerSeg.el), field('Codec', codecSel.el, codecNote), compressBlock);
  const audioBlock = h('div', { class: 'stack' }, field('Format audio', audioSeg.el), h('div', { class: 'mp3-only' }, field('Débit', bitrateSel.el)), h('div', { class: 'pcm-only' }, field('Profondeur', depthSeg.el)));
  const optionsCard = h(
    'section',
    { class: 'card settings' },
    h('div', { class: 'section__head' }, h('h2', { class: 'section__title' }, 'Téléchargement')),
    modeSeg.el,
    videoBlock,
    audioBlock,
    clipBlock,
    estimateLine,
    h('details', { class: 'advanced' },
      h('summary', {}, 'Session et dossier'),
      field('Session (contenus privés, Instagram, YouTube restreint)', cookiesSel.el, h('p', { class: 'field__hint' }, 'Utilise ta connexion du navigateur choisi. macOS peut demander l\'accès au trousseau la première fois.')),
      field('Dossier', h('div', { class: 'row' }, dirLabel, dirBtn)),
    ),
  );

  const dlBtn = h('button', { type: 'button', class: 'btn btn--primary media-go' }, icon('download', 16), h('span', {}, 'Télécharger'));
  dlBtn.addEventListener('click', () => startAll());

  const queue = h('div', { class: 'media-queue' });
  const queueCard = h('section', { class: 'card' }, h('div', { class: 'section__head' }, h('h2', { class: 'section__title' }, 'Téléchargements')), queue);

  const work = h('div', { class: 'stack media-work' }, linkCard, optionsCard, dlBtn, queueCard);
  root.append(statusBox, work);

  // ---------- Rendu ----------
  function renderStatus() {
    if (checking && !status) {
      statusBox.className = 'card engine';
      statusBox.replaceChildren(h('span', { class: 'spinner spinner--sm' }), h('span', { class: 'muted' }, 'Vérification du moteur…'));
      work.hidden = true;
      return;
    }
    if (status) {
      statusBox.className = 'card engine engine--ok';
      statusBox.replaceChildren(icon('check', 14), h('span', {}, `Moteur prêt · yt-dlp ${status.ytdlp} · ffmpeg ${status.ffmpeg}`));
      dirLabel.textContent = status.dir.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
      dirLabel.title = status.dir;
    } else {
      statusBox.className = 'card engine engine--missing';
      const err = engineError();
      const detail = err && !/not found/i.test(err) ? [h('p', { class: 'field__hint' }, `Détail : ${err}`)] : [];
      statusBox.replaceChildren(
        h('div', { class: 'engine__title' }, icon('alert', 15), h('strong', {}, 'Moteur non installé')),
        h('p', {}, `Les téléchargements passent par yt-dlp et ffmpeg (gratuits, open source) installés sur ton ordinateur. Lance une fois cette commande dans ${WINDOWS ? 'PowerShell' : 'le Terminal'}, puis rouvre le panneau :`),
        h('pre', { class: 'mono engine__cmd' }, WINDOWS
          ? 'irm https://raw.githubusercontent.com/adpzt/kotak/main/scripts/install-windows.ps1 | iex'
          : 'curl -fsSL https://raw.githubusercontent.com/adpzt/kotak/main/scripts/install-mac.sh | bash'),
        ...detail,
      );
    }
    work.hidden = !status;
  }

  function renderOptions() {
    modeSeg.sync();
    qualitySel.sync();
    containerSeg.sync();
    codecSel.sync();
    audioSeg.sync();
    bitrateSel.sync();
    depthSeg.sync();
    cookiesSel.sync();
    if (document.activeElement !== startInput) startInput.value = opts.start;
    if (document.activeElement !== endInput) endInput.value = opts.end;
    clipToggle.checked = clipOn;
    clipRow.hidden = !clipOn;
    clipBlock.hidden = opts.mode === 'image';
    const dur = analyzed.length === 1 ? analyzed[0].duration : null;
    clipHint.textContent = `${dur ? `Durée totale : ${fmtTime(dur)}. ` : ''}Formats acceptés : 90 · 1:30 · 1:02:03 · 1m30s. ⏱ reprend la position de la vidéo en cours dans l'onglet.`;
    const clip = clipLabel();
    cookiesSel.el.value = opts.cookies;
    videoBlock.hidden = opts.mode !== 'video';
    audioBlock.hidden = opts.mode !== 'audio';
    (audioBlock.querySelector('.mp3-only') as HTMLElement).hidden = opts.audio !== 'mp3';
    (audioBlock.querySelector('.pcm-only') as HTMLElement).hidden = !['wav', 'aiff'].includes(opts.audio);
    containerSeg.el.hidden = opts.codec === 'prores';
    codecNote.textContent =
      opts.codec === 'original'
        ? 'Attention : la 4K YouTube n\'existe qu\'en VP9 / AV1, que QuickTime et Keynote ne lisent pas. Choisis H.264 pour être tranquille.'
        : opts.codec === 'prores'
          ? 'Toujours en .mov, son en PCM. Idéal pour le montage, environ 10× plus lourd.'
          : 'Converti avec l\'encodeur matériel du Mac (rapide).';
    const canCompress = opts.mode === 'video' && opts.codec !== 'prores' && opts.container !== 'webm';
    const compressing = canCompress && opts.compressOn;
    compressBlock.hidden = !canCompress;
    compressToggle.checked = opts.compressOn;
    compressDetail.hidden = !opts.compressOn;
    if (document.activeElement !== compressSlider) compressSlider.value = String(opts.compress);
    compressSlider.style.setProperty('--fill', `${((opts.compress - 5) / 85) * 100}%`);
    compressValue.textContent = `${opts.compress} %`;
    const est = estimate();
    compressHint.textContent = est
      ? `≈ ${formatMB(est)} → ≈ ${formatMB(est * (1 - opts.compress / 100))}. ${opts.codec === 'hevc' ? 'En HEVC.' : 'En H.264 (vidéos HDR gardées en HEVC 10 bits).'}`
      : 'Le poids final sera réduit de ce pourcentage.';
    estimateLine.hidden = !est || opts.mode === 'image';
    estimateLine.textContent = est
      ? `Poids estimé : ≈ ${formatMB(compressing ? est * (1 - opts.compress / 100) : est)}${compressing ? ` (au lieu de ≈ ${formatMB(est)})` : ''}`
      : '';
    (dlBtn.lastElementChild as HTMLElement).textContent =
      (analyzed.length > 1 ? `Télécharger les ${analyzed.length}` : 'Télécharger') + (clip && opts.mode !== 'image' ? ` · passage ${clip}` : '') + (compressing ? ` · −${opts.compress} %` : '');
    dlBtn.disabled = analyzed.length === 0;
  }

  /** Poids total estimé des liens analysés (octets), avant compression ; null si inconnu. */
  function estimate(): number | null {
    if (!analyzed.length) return null;
    let clipSeconds: number | null = null;
    if (clipOn && analyzed.length === 1) {
      const a = parseTime(opts.start) ?? 0;
      const b = parseTime(opts.end) ?? analyzed[0].duration ?? null;
      if (b !== null && b > a) clipSeconds = b - a;
    }
    const sizes = analyzed.map((i) => estimateDownload(i, opts, clipSeconds));
    if (sizes.some((x) => x === null)) return null;
    return (sizes as number[]).reduce((a, b) => a + b, 0) || null;
  }

  /** « 1:30 → 2:00 » si un passage valide est demandé, sinon null. */
  function clipLabel(): string | null {
    if (!clipOn) return null;
    const a = parseTime(opts.start);
    const b = parseTime(opts.end);
    if (a === null && b === null) return null;
    return `${fmtTime(a ?? 0)} → ${b === null ? 'fin' : fmtTime(b)}`;
  }

  function renderResults(errors: string[]) {
    results.replaceChildren(
      ...analyzed.map((i) =>
        h(
          'div',
          { class: 'media-item' },
          i.thumbnail ? h('img', { class: 'media-item__thumb', src: i.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'media-item__thumb' }, icon(i.hasVideo ? 'film' : 'music', 20)),
          h(
            'div',
            { class: 'media-item__body' },
            h('div', { class: 'media-item__title', title: i.title }, i.title),
            h('div', { class: 'media-item__meta muted' }, [i.site, i.uploader, fmtDuration(i.duration), qualityLabel(i.maxHeight)].filter(Boolean).join(' · ')),
          ),
        ),
      ),
      ...errors.map((e) => h('div', { class: 'preview__warn' }, icon('alert', 14), h('span', {}, e))),
    );
  }

  async function analyze() {
    const urls = [...new Set(links.value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
    if (!urls.length || !status) return;
    analyzeBtn.disabled = true;
    results.replaceChildren(h('div', { class: 'importing' }, h('span', { class: 'spinner spinner--sm' }), h('span', {}, `Analyse de ${urls.length} lien${urls.length > 1 ? 's' : ''}…`)));
    const errors: string[] = [];
    const found: ProbeInfo[] = [];
    await Promise.all(
      urls.map(async (u) => {
        try {
          found.push(await engine.probe(u, opts.cookies));
        } catch (e) {
          errors.push(`${u.slice(0, 60)} : ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
    analyzed = urls.map((u) => found.find((f) => f.url === u || u.includes(f.url) || f.url.includes(u))).filter((f): f is ProbeInfo => !!f);
    // Liens redirigés (URL finale différente) : on garde aussi ceux non appariés.
    for (const f of found) if (!analyzed.includes(f)) analyzed.push(f);
    analyzeBtn.disabled = false;
    // Lien avec un moment (?t=, start=/end= du lecteur intégré) : on pré-remplit le passage.
    const times = urls.map(timesFromUrl).find((t) => t.start !== null || t.end !== null);
    if (times && urls.length === 1) {
      clipOn = true;
      opts.start = times.start !== null ? fmtTime(times.start) : '';
      opts.end = times.end !== null ? fmtTime(times.end) : '';
      toast(`Passage repris du lien : ${clipLabel()}`, 'info', 3500);
    }
    renderResults(errors);
    renderOptions();
  }

  function startAll() {
    let start = '';
    let end = '';
    if (clipOn && opts.mode !== 'image') {
      const a = opts.start ? parseTime(opts.start) : 0;
      const b = opts.end ? parseTime(opts.end) : null;
      const dur = analyzed.length === 1 ? analyzed[0].duration : null;
      if (a === null || (opts.end && b === null)) return toast('Moment invalide : utilise par exemple 1:30 ou 90', 'error');
      if (b !== null && b <= a) return toast('La fin doit être après le début', 'error');
      if (dur && a >= dur) return toast(`Le début dépasse la durée de la vidéo (${fmtTime(dur)})`, 'error');
      start = String(a);
      end = b === null ? '' : String(b);
    }
    for (const info of analyzed) startJob(info, start, end);
    analyzed = [];
    links.value = '';
    results.replaceChildren();
    renderOptions();
  }

  function startJob(info: ProbeInfo, start: string, end: string) {
    const job: Job = { key: `j${jobs.length + 1}`, info, opts: { ...opts, start, end }, requestId: null, state: 'running', event: { type: 'stage', stage: 'Préparation' } };
    jobs.unshift(job);
    const { compressOn, ...rest } = job.opts;
    const compress = compressOn && rest.mode === 'video' && rest.codec !== 'prores' && rest.container !== 'webm' ? rest.compress : 0;
    job.opts.compress = compress;
    const req = engine.download({ url: info.url, ...rest, compress }, (e) => {
      job.event = { ...job.event, ...e };
      renderJob(job);
    });
    job.requestId = req.id;
    req.promise
      .then((done) => {
        job.state = 'done';
        job.file = done.file;
        job.size = done.size;
        renderJob(job);
        toast(`Téléchargé : ${info.title.slice(0, 50)}`, 'success');
      })
      .catch((e) => {
        job.state = job.state === 'cancelled' ? 'cancelled' : 'error';
        job.event = { type: 'error', message: e instanceof Error ? e.message : String(e) };
        renderJob(job);
      });
    renderQueue();
  }

  function renderQueue() {
    queueCard.hidden = jobs.length === 0;
    queue.replaceChildren(...jobs.map((j) => (j.el ??= h('div', { class: 'job' }))));
    jobs.forEach(renderJob);
  }

  function renderJob(job: Job) {
    if (!job.el) return renderQueue();
    const e = job.event;
    const passage = job.opts.start || job.opts.end ? ` · ${fmtTime(+job.opts.start || 0)}→${job.opts.end ? fmtTime(+job.opts.end) : 'fin'}` : '';
    const squeeze = job.opts.mode === 'video' && job.opts.compress ? ` · −${job.opts.compress} %` : '';
    const label = (job.opts.mode === 'audio' ? job.opts.audio.toUpperCase() : job.opts.mode === 'image' ? 'Image' : `${job.opts.codec === 'prores' ? 'MOV' : job.opts.container.toUpperCase()} ${job.opts.quality ? qualityLabel(job.opts.quality) : 'max'}`) + passage + squeeze;
    const actions: Node[] = [];
    if (job.state === 'running') {
      const stop = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: 'Annuler' }, icon('stop', 13));
      stop.addEventListener('click', () => {
        job.state = 'cancelled';
        if (job.requestId) engine.cancel(job.requestId).catch(() => undefined);
      });
      actions.push(stop);
    } else if (job.state === 'done' && job.file) {
      const reveal = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: 'Afficher dans le Finder' }, icon('folder', 13));
      reveal.addEventListener('click', () => engine.reveal(job.file!));
      const open = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: 'Ouvrir' }, icon('play', 13));
      open.addEventListener('click', () => engine.open(job.file!));
      actions.push(reveal, open);
      if (job.opts.mode === 'image') {
        const conv = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', title: 'Envoyer au convertisseur' }, icon('send', 13));
        conv.addEventListener('click', async () => {
          const bytes = await engine.readFile(job.file!);
          showModule('convert');
          await store.addFiles([{ blob: new Blob([bytes as BlobPart], { type: 'image/png' }), name: job.file!.split('/').pop()! }]);
        });
        actions.push(conv);
      }
    }
    const pct = job.state === 'done' ? 100 : e.percent ?? 0;
    const line =
      job.state === 'done'
        ? `Terminé · ${job.opts.mode === 'video' ? formatMB(job.size ?? 0) : formatBytes(job.size ?? 0)}`
        : job.state === 'cancelled'
          ? 'Annulé'
          : job.state === 'error'
            ? e.message ?? 'Erreur'
            : [e.stage, e.percent !== undefined ? `${Math.round(e.percent)} %` : '', e.speed, e.eta && e.eta !== 'Unknown' ? `reste ${e.eta}` : ''].filter(Boolean).join(' · ');
    job.el.className = `job job--${job.state}`;
    job.el.replaceChildren(
      h(
        'div',
        { class: 'job__top' },
        h('span', { class: 'job__title', title: job.info.title }, job.info.title),
        h('span', { class: 'pill pill--sm pill--neutral' }, label),
        h('div', { class: 'job__actions' }, ...actions),
      ),
      h('div', { class: 'job__bar' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'job__line' }, line),
    );
  }

  async function refreshStatus() {
    checking = true;
    renderStatus();
    status = await engineStatus();
    checking = false;
    renderStatus();
  }

  onModuleChange((m) => {
    if (m === 'media' && !status) refreshStatus();
  });
  if (currentModule() === 'media') await refreshStatus();
  else renderStatus();
  renderOptions();
  renderQueue();
}
