import { PREVIEW_ORIGIN, DEFAULT_SHARE, CHECKS, buildFrameUrl, validateResults } from './viewer-config.mjs';
const setup = document.querySelector('#setup');
const share = document.querySelector('#share-link');
const variant = document.querySelector('#variant');
const shell = document.querySelector('#frame-shell');
const state = document.querySelector('#frame-state');
const error = document.querySelector('#error');
const fullscreen = document.querySelector('#fullscreen');
let activeFrame = null;
let activeVariant = null;
let activeUrl = null;
share.value = DEFAULT_SHARE;
document.querySelector('#parent-origin').textContent = location.origin;
document.querySelector('#viewer-origin').textContent = PREVIEW_ORIGIN;
for (const [key, label] of Object.entries(CHECKS)) {
  const row = document.createElement('div'); row.className = 'check-row';
  const text = document.createElement('label'); text.htmlFor = `check-${key}`; text.textContent = label;
  const select = document.createElement('select'); select.id = `check-${key}`; select.dataset.check = key;
  for (const [value, caption] of [['untested', 'Not tested'], ['pass', 'Pass · observed'], ['fail', 'Fail · observed'], ['unavailable', 'Unavailable / N/A']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = caption; select.append(option);
  }
  row.append(text, select); document.querySelector('#checks').append(row);
}
function showError(message) { error.textContent = message; error.hidden = !message; }
function resetObservations() { for (const input of document.querySelectorAll('[data-check]')) input.value = 'untested'; }
function unload() {
  activeFrame?.remove(); activeFrame = null; activeUrl = null; activeVariant = null;
  document.querySelector('#empty').hidden = false; fullscreen.disabled = true;
  state.textContent = 'Viewer unloaded. No rendered result is assumed.';
}
setup.addEventListener('submit', event => {
  event.preventDefault(); showError('');
  let url;
  try { url = buildFrameUrl(share.value, variant.value); }
  catch (reason) { showError(reason instanceof Error ? reason.message : 'Invalid model link.'); return; }
  if (location.origin === PREVIEW_ORIGIN) { showError('This acceptance page needs a different origin from the viewer.'); return; }
  unload(); resetObservations();
  const frame = document.createElement('iframe');
  frame.title = 'Interactive 3D model acceptance'; frame.allow = 'fullscreen; xr-spatial-tracking';
  frame.allowFullscreen = true; frame.referrerPolicy = 'no-referrer';
  frame.addEventListener('load', () => {
    if (activeFrame === frame) state.textContent = 'Frame navigation completed. Visually verify the model and any protection screen.';
  });
  activeFrame = frame; activeUrl = url; activeVariant = variant.value;
  frame.src = url; document.querySelector('#empty').hidden = true; shell.append(frame);
  fullscreen.disabled = typeof shell.requestFullscreen !== 'function';
  state.textContent = 'Loading frame… No automatic pass is recorded.';
});
variant.addEventListener('change', () => { share.disabled = variant.value === 'demo'; unload(); resetObservations(); showError(''); });
share.addEventListener('input', () => { unload(); resetObservations(); showError(''); });
document.querySelector('#unload').addEventListener('click', () => { unload(); showError(''); });
for (const button of document.querySelectorAll('[data-width]')) button.addEventListener('click', () => {
  shell.dataset.width = button.dataset.width;
  document.querySelector('#check-layout').value = 'untested';
  for (const other of document.querySelectorAll('[data-width]')) other.setAttribute('aria-pressed', String(other === button));
});
fullscreen.addEventListener('click', async () => {
  showError('');
  try {
    if (document.fullscreenElement === shell) await document.exitFullscreen();
    else if (activeFrame && typeof shell.requestFullscreen === 'function') await shell.requestFullscreen();
  } catch { showError('Parent-page fullscreen was denied or unavailable. Record this result; browser fullscreen is a different test.'); }
});
document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement === shell ? 'Exit fullscreen frame' : 'Fullscreen frame'; });
document.querySelector('#exit-fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement === shell) await document.exitFullscreen(); }
  catch { showError('Could not exit fullscreen. Use the browser exit control or Escape.'); }
});
document.querySelector('#download').addEventListener('click', () => {
  if (!activeFrame || !activeUrl) { showError('Open a viewer before exporting observations.'); return; }
  const observations = Object.fromEntries(Array.from(document.querySelectorAll('[data-check]'), input => [input.dataset.check, input.value]));
  const report = { recordedAt: new Date().toISOString(), type: 'self-reported manual acceptance',
    parentOrigin: location.origin, viewerUrl: activeUrl, variant: activeVariant,
    frameWidth: activeFrame.clientWidth, frameHeight: activeFrame.clientHeight,
    results: validateResults(observations), limits: ['Frame load is not proof of model rendering.', 'Demo is not a real Free-owner cloud model.', 'Parent fullscreen is separate from a viewer fullscreen button.'] };
  const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = blobUrl; link.download = 'iframe-acceptance.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
});
