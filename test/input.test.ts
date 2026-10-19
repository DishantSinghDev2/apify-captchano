import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InputError, normalizeInput, validateTask } from '../src/input.js';
import { KEY } from './helpers.js';

test('missing or malformed apiKey -> invalid_api_key InputError', () => {
  assert.throws(() => normalizeInput({ tasks: [{ type: 'turnstile', url: 'https://a.b' }] }), (e: unknown) => e instanceof InputError && e.code === 'invalid_api_key');
  assert.throws(() => normalizeInput({ apiKey: 'sk-nope', type: 'turnstile', url: 'https://a.b' }), (e: unknown) => e instanceof InputError && e.code === 'invalid_api_key');
});

test('no tasks and no type -> invalid_input', () => {
  assert.throws(() => normalizeInput({ apiKey: KEY, tasks: [] }), (e: unknown) => e instanceof InputError && e.code === 'invalid_input');
});

test('defaults and bounds', () => {
  const n = normalizeInput({ apiKey: KEY, type: 'turnstile', url: 'https://a.b', sitekey: '0x4' });
  assert.equal(n.waitSeconds, 60);
  assert.equal(n.concurrency, 5);
  assert.equal(n.maxSpendUsd, undefined);
  assert.equal(n.tasks.length, 1);
  assert.deepEqual(n.tasks[0]!.request, { type: 'turnstile', url: 'https://a.b', sitekey: '0x4' });
  assert.throws(() => normalizeInput({ apiKey: KEY, type: 'turnstile', url: 'https://a.b', waitSeconds: 121 }), InputError);
  assert.throws(() => normalizeInput({ apiKey: KEY, type: 'turnstile', url: 'https://a.b', concurrency: 51 }), InputError);
  assert.throws(() => normalizeInput({ apiKey: KEY, type: 'turnstile', url: 'https://a.b', maxSpendUsd: -1 }), InputError);
});

test('tasks array takes precedence over single-task fields', () => {
  const n = normalizeInput({
    apiKey: KEY,
    type: 'image',
    tasks: [{ type: 'recaptcha_v2', url: 'https://www.google.com/recaptcha/api2/demo', sitekey: 'k' }],
  });
  assert.equal(n.tasks[0]!.request?.type, 'recaptcha_v2');
});

test('per-task validation rules', () => {
  assert.deepEqual(validateTask({ type: 'nope', url: 'https://a.b' }, 0).errors.length, 1);
  assert.match(validateTask({ type: 'recaptcha_v2' }, 0).errors.join(), /url/);
  assert.match(validateTask({ type: 'recaptcha_v2', url: 'ftp://x' }, 0).errors.join(), /http/);
  assert.match(validateTask({ type: 'image' }, 0).errors.join(), /body/);
  assert.equal(validateTask({ type: 'image', body: 'aGVsbG8=' }, 0).errors.length, 0);
  const dd = validateTask({ type: 'datadome', url: 'https://a.b' }, 0).errors.join();
  assert.match(dd, /challengeUrl/);
  assert.match(dd, /proxy/);
  assert.match(validateTask({ type: 'recaptcha_v3', url: 'https://a.b', minScore: 0.95 }, 0).errors.join(), /minScore/);
  assert.match(validateTask({ type: 'turnstile', url: 'https://a.b', proxy: 'not a proxy' }, 0).errors.join(), /proxy/);
  assert.match(validateTask('string', 0).errors.join(), /object/);
});

test('unknown fields (e.g. an apiKey pasted into a task) are dropped from the request', () => {
  const t = validateTask({ type: 'turnstile', url: 'https://a.b', apiKey: KEY, foo: 1 }, 0);
  assert.deepEqual(t.request, { type: 'turnstile', url: 'https://a.b' });
});

test('valid datadome task with socks5 proxy', () => {
  const t = validateTask({ type: 'datadome', url: 'https://a.b', challengeUrl: 'https://geo.captcha-delivery.com/x', proxy: 'socks5://u:p@1.2.3.4:1080' }, 3);
  assert.deepEqual(t.errors, []);
  assert.equal(t.index, 3);
});
