import test from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_ORIGIN, DEFAULT_SHARE, buildFrameUrl, validateResults } from '../viewer-config.mjs';

test('standard share keeps only the fixed host, exact model and embed mode', () => {
  assert.equal(buildFrameUrl(`${DEFAULT_SHARE}?secret=discarded&theme=dark#discarded`, 'standard'), `${DEFAULT_SHARE}?embed=true`);
});
test('custom case rebuilds supported appearance parameters', () => {
  const url = new URL(buildFrameUrl(DEFAULT_SHARE, 'pro-custom'));
  assert.equal(url.searchParams.get('theme'), 'dark');
  assert.equal(url.searchParams.get('controls'), 'hide');
  assert.equal(url.searchParams.get('branding'), 'show');
});
test('demo is fixed and deliberately requests options the demo should ignore', () => {
  const url = new URL(buildFrameUrl('ignored', 'demo'));
  assert.equal(url.pathname, '/v/demo-glb'); assert.equal(url.searchParams.get('branding'), 'hide');
});
test('other origins, credentials, unrelated paths and invalid variants are rejected', () => {
  for (const value of ['https://other.test/v/demo-glb', `http://${new URL(PREVIEW_ORIGIN).hostname}/v/demo-glb`,
    `${PREVIEW_ORIGIN}/dashboard`, `${PREVIEW_ORIGIN}/v/../login`, `https://user:pass@${new URL(PREVIEW_ORIGIN).hostname}/v/demo-glb`, 'javascript:alert(1)']) {
    assert.throws(() => buildFrameUrl(value, 'standard'));
  }
  assert.throws(() => buildFrameUrl(DEFAULT_SHARE, 'unsupported'));
});
test('public UUID share paths are accepted without a client assertion about the owner plan', () => {
  const url = `${PREVIEW_ORIGIN}/v/11111111-1111-4111-8111-111111111111`;
  assert.equal(buildFrameUrl(url, 'standard'), `${url}?embed=true`);
});
test('missing and unknown observations remain untested, never auto-pass', () => {
  const results = validateResults({ model: 'pass', navigation: 'fail', fullscreen: 'unavailable', appearance: 'yes' });
  assert.equal(results.model, 'pass'); assert.equal(results.navigation, 'fail');
  assert.equal(results.fullscreen, 'unavailable'); assert.equal(results.appearance, 'untested');
  assert.equal(results.anonymous, 'untested'); assert.equal(results.layout, 'untested');
});
