import './styles.css';
import { store } from './store';
import { loadSettings } from '../lib/storage';
import { mountDropzone } from './components/dropzone';
import { mountCompare } from './components/compare';
import { mountSettings } from './components/settings';
import { mountQueue } from './components/queue';
import { mountFooter } from './components/footer';
import { mountPresets } from './components/presets';
import { mountNav } from './nav';
import { mountColors } from './modules/colors';
import { mountGrab } from './modules/grab';
import { mountMedia } from './modules/media';
import { mountVideos } from './components/videos';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

async function boot() {
  store.init(await loadSettings());
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  mountDropzone($('dropzone'));
  await mountVideos($('videos'));
  mountCompare($('preview'));
  mountSettings($('settings'));
  mountQueue($('queue'));
  mountFooter($('footer'));
  await mountPresets($('presets'), $('preset-form'));
  await mountColors($('mod-colors'));
  mountGrab($('mod-grab'), $('grab-footer'));
  await mountMedia($('mod-media'));
  mountNav($('tabs'));
  document.body.classList.add('is-ready');
}

boot();
