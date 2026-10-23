export const PREVIEW_ORIGIN = 'https://3-d-viewer-convert-lezza5xxn-akiratoolsteam-9531s-projects.vercel.app';
export const DEFAULT_SHARE = `${PREVIEW_ORIGIN}/v/3d2f3c77-78b9-4612-92ab-c04f72864b78`;
export const CHECKS = {
  model: 'Model visibly rendered', navigation: 'Rotate and zoom work',
  appearance: 'Branding and controls match owner entitlement', layout: 'Frame fits; parent page remains usable',
  fullscreen: 'Parent-page fullscreen enters and exits', anonymous: 'Works without application sign-in',
};
export function buildFrameUrl(value, variant) {
  if (!['standard', 'pro-custom', 'demo'].includes(variant)) throw new Error('Choose a supported appearance request.');
  const url = new URL(variant === 'demo' ? `${PREVIEW_ORIGIN}/v/demo-glb` : value.trim());
  if (url.origin !== PREVIEW_ORIGIN || url.username || url.password ||
    !/^\/v\/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|demo-[a-z0-9-]+)$/i.test(url.pathname)) {
    throw new Error('Use a public model link from the fixed PR16 Preview host.');
  }
  url.search = ''; url.hash = '';
  url.searchParams.set('embed', 'true');
  if (variant !== 'standard') {
    url.searchParams.set('theme', 'dark'); url.searchParams.set('controls', 'hide');
    url.searchParams.set('branding', variant === 'demo' ? 'hide' : 'show');
  }
  return url.toString();
}
export function validateResults(results) {
  const states = ['untested', 'pass', 'fail', 'unavailable'];
  return Object.fromEntries(Object.keys(CHECKS).map(key => [key, states.includes(results[key]) ? results[key] : 'untested']));
}
