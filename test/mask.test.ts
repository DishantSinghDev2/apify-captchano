import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectSecrets, createRedactor, maskApiKey, maskProxy, sanitizeTaskEcho } from '../src/mask.js';
import { KEY } from './helpers.js';

test('maskApiKey never returns the key', () => {
  const m = maskApiKey(KEY);
  assert.notEqual(m, KEY);
  assert.ok(!m.includes('secret'));
  assert.equal(m, 'cn-***cret');
  assert.equal(maskApiKey('cn-short'), '***');
  assert.equal(maskApiKey(undefined), '(none)');
});

test('maskProxy strips credentials from strings and objects', () => {
  assert.equal(maskProxy('http://alice:hunter2@1.2.3.4:8080'), 'http://***:***@1.2.3.4:8080');
  assert.equal(maskProxy('socks5://bob:p%40ss@proxy.example:1080'), 'socks5://***:***@proxy.example:1080');
  assert.equal(maskProxy('alice:hunter2@1.2.3.4:8080'), '***:***@1.2.3.4:8080');
  assert.equal(maskProxy('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.deepEqual(maskProxy({ type: 'http', host: 'h', port: 1, username: 'alice', password: 'hunter2' }), {
    type: 'http', host: 'h', port: 1, username: '***', password: '***',
  });
});

test('sanitizeTaskEcho masks proxy, summarises image, drops key-like fields', () => {
  const echo = sanitizeTaskEcho({
    type: 'image',
    body: 'aGVsbG8gd29ybGQ=',
    proxy: 'http://alice:hunter2@1.2.3.4:8080',
    ...({ apiKey: KEY } as object),
  });
  const s = JSON.stringify(echo);
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('alice'));
  assert.ok(!s.includes(KEY));
  assert.equal(echo.body, '[base64 image, 16 chars]');
});

test('redactor scrubs API key and proxy credentials from arbitrary text', () => {
  const redact = createRedactor(collectSecrets(KEY, [
    { proxy: 'http://alice123:hunter2@1.2.3.4:8080' },
    { proxy: { username: 'bobuser', password: 'pa55word' } },
  ]));
  const out = redact(`key=${KEY} proxy=http://alice123:hunter2@1.2.3.4:8080 pw=pa55word user=bobuser`);
  for (const s of [KEY, 'hunter2', 'alice123', 'pa55word', 'bobuser']) assert.ok(!out.includes(s), `${s} leaked: ${out}`);
});
