import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CaptchaNoClient, CaptchaNoError } from '../src/client.js';
import { KEY, mockFetch, noSleep } from './helpers.js';

const demo = { type: 'recaptcha_v2' as const, url: 'https://www.google.com/recaptcha/api2/demo', sitekey: '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-' };

test('200 ready: sends Bearer auth, wait param and body', async () => {
  const { fetch, calls } = mockFetch(() => ({
    status: 200,
    body: { id: 't1', type: 'recaptcha_v2', status: 'ready', solution: { token: 'TOKEN' }, cost: '0.00285', createdAt: 'x' },
  }));
  const client = new CaptchaNoClient({ apiKey: KEY, fetch });
  const { task, attempts, polls } = await client.solveAndWait(demo, { waitSeconds: 60, sleep: noSleep });
  assert.equal(task.solution?.token, 'TOKEN');
  assert.equal(attempts, 1);
  assert.equal(polls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.captchano.com/v1/solve?wait=60');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0]!.body, demo);
});

test('wait is capped at 120', async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 200, body: { id: 't', type: 'turnstile', status: 'ready', solution: { token: 'x' } } }));
  await new CaptchaNoClient({ apiKey: KEY, fetch }).solve({ type: 'turnstile', url: 'https://a.b' }, 999);
  assert.match(calls[0]!.url, /wait=120$/);
});

test('202 -> polls GET /v1/task/{id} every 5 s until ready', async () => {
  const sleeps: number[] = [];
  const { fetch, calls } = mockFetch((call, n) => {
    if (call.method === 'POST') return { status: 202, body: { id: 'abc', type: 'recaptcha_v2', status: 'solving' } };
    if (n < 4) return { status: 200, body: { id: 'abc', type: 'recaptcha_v2', status: 'solving' } };
    return { status: 200, body: { id: 'abc', type: 'recaptcha_v2', status: 'ready', solution: { token: 'T' }, cost: '0.001' } };
  });
  const client = new CaptchaNoClient({ apiKey: KEY, fetch });
  const { task, polls } = await client.solveAndWait(demo, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(task.status, 'ready');
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [5000, 5000, 5000]);
  assert.equal(calls[1]!.url, 'https://api.captchano.com/v1/task/abc');
  assert.equal(calls[1]!.method, 'GET');
});

test('202 -> poll timeout after 180 s', async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 202, body: { id: 'slow', type: 'turnstile', status: 'solving' } }));
  const client = new CaptchaNoClient({ apiKey: KEY, fetch });
  await assert.rejects(
    client.solveAndWait({ type: 'turnstile', url: 'https://a.b' }, { sleep: noSleep }),
    (e: unknown) => e instanceof CaptchaNoError && e.code === 'poll_timeout' && e.task?.id === 'slow',
  );
  assert.equal(calls.length, 1 + 36); // 180 s / 5 s
});

test('transient poll errors keep polling', async () => {
  const { fetch } = mockFetch((call, n) => {
    if (call.method === 'POST') return { status: 202, body: { id: 'p', type: 'turnstile', status: 'solving' } };
    if (n === 2) return { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } };
    return { status: 200, body: { id: 'p', type: 'turnstile', status: 'ready', solution: { token: 'ok' } } };
  });
  const { task } = await new CaptchaNoClient({ apiKey: KEY, fetch }).solveAndWait({ type: 'turnstile', url: 'https://a.b' }, { sleep: noSleep });
  assert.equal(task.solution?.token, 'ok');
});

test('retries 429 rate_limited with exponential backoff then succeeds', async () => {
  const delays: number[] = [];
  const { fetch, calls } = mockFetch((_c, n) =>
    n <= 2
      ? { status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests' } } }
      : { status: 200, body: { id: 'r', type: 'recaptcha_v2', status: 'ready', solution: { token: 'T' } } },
  );
  const { attempts } = await new CaptchaNoClient({ apiKey: KEY, fetch }).solveAndWait(demo, {
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.equal(attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test('capacity_unavailable is retried at most 3 times', async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 503, body: { error: { code: 'capacity_unavailable', message: 'busy' } } }));
  await assert.rejects(
    new CaptchaNoClient({ apiKey: KEY, fetch }).solveAndWait(demo, { sleep: noSleep }),
    (e: unknown) => e instanceof CaptchaNoError && e.code === 'capacity_unavailable',
  );
  assert.equal(calls.length, 4); // 1 + 3 retries
});

test('422 failed task with capacity_unavailable is retried; unsolvable is not', async () => {
  const a = mockFetch((_c, n) =>
    n === 1
      ? { status: 422, body: { id: 'f1', type: 'turnstile', status: 'failed', error: { code: 'capacity_unavailable', message: 'busy' } } }
      : { status: 200, body: { id: 'f2', type: 'turnstile', status: 'ready', solution: { token: 'T' } } },
  );
  const r = await new CaptchaNoClient({ apiKey: KEY, fetch: a.fetch }).solveAndWait({ type: 'turnstile', url: 'https://a.b' }, { sleep: noSleep });
  assert.equal(r.task.status, 'ready');
  assert.equal(r.attempts, 2);

  const b = mockFetch(() => ({ status: 422, body: { id: 'u', type: 'turnstile', status: 'failed', error: { code: 'unsolvable', message: 'no' } } }));
  const r2 = await new CaptchaNoClient({ apiKey: KEY, fetch: b.fetch }).solveAndWait({ type: 'turnstile', url: 'https://a.b' }, { sleep: noSleep });
  assert.equal(r2.task.status, 'failed');
  assert.equal(r2.task.error?.code, 'unsolvable');
  assert.equal(b.calls.length, 1);
});

test('401 -> invalid_api_key, not retried', async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 401, body: { error: { code: 'invalid_api_key', message: 'Invalid API key' } } }));
  await assert.rejects(
    new CaptchaNoClient({ apiKey: KEY, fetch }).solveAndWait(demo, { sleep: noSleep }),
    (e: unknown) => e instanceof CaptchaNoError && e.code === 'invalid_api_key' && e.httpStatus === 401,
  );
  assert.equal(calls.length, 1);
});

test('402 -> insufficient_balance; getBalance parses', async () => {
  const { fetch } = mockFetch((c) =>
    c.url.endsWith('/v1/balance')
      ? { status: 200, body: { balance: '1.50', currency: 'USD' } }
      : { status: 402, body: { error: { code: 'insufficient_balance', message: 'Top up' } } },
  );
  const client = new CaptchaNoClient({ apiKey: KEY, fetch });
  assert.deepEqual(await client.getBalance(), { balance: '1.50', currency: 'USD' });
  await assert.rejects(client.solve(demo, 10), (e: unknown) => e instanceof CaptchaNoError && e.code === 'insufficient_balance');
});

test('network failure -> network_error', async () => {
  const client = new CaptchaNoClient({ apiKey: KEY, fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(client.getBalance(), (e: unknown) => e instanceof CaptchaNoError && e.code === 'network_error');
});
