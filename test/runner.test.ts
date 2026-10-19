import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CaptchaNoClient } from '../src/client.js';
import { validateTask } from '../src/input.js';
import { FatalApiKeyError, runTasks, type ResultItem } from '../src/runner.js';
import { KEY, mockFetch, noSleep } from './helpers.js';

const entries = (n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => validateTask({ type: 'turnstile', url: 'https://a.b', sitekey: `k${i}`, ...extra }, i));

const ready = (id: string, cost = '0.002') => ({ status: 200, body: { id, type: 'turnstile', status: 'ready', solution: { token: `tok-${id}` }, cost } });

test('pushes one item per task with mixed outcomes; summary totals cost', async () => {
  const { fetch } = mockFetch((c) => {
    const k = (c.body as { sitekey: string }).sitekey;
    if (k === 'k1') return { status: 422, body: { id: 'x1', type: 'turnstile', status: 'failed', error: { code: 'unsolvable', message: 'nope' } } };
    return ready(k);
  });
  const list = [...entries(3), validateTask({ type: 'turnstile' }, 3)];
  const pushed: ResultItem[] = [];
  const { summary, items } = await runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), list, {
    concurrency: 2,
    solveOptions: { sleep: noSleep },
    onResult: (i) => { pushed.push(i); },
  });
  assert.equal(pushed.length, 4);
  assert.equal(summary.solved, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.totalCostUsd, 0.004);
  assert.equal(items[1]!.errorCode, 'unsolvable');
  assert.equal(items[1]!.costUsd, 0);
  assert.equal(items[3]!.status, 'invalid');
  assert.equal(items[0]!.token, 'tok-k0');
  assert.equal(items[0]!.solutionPreview, 'tok-k0');
});

test('bounded concurrency is respected', async () => {
  let inFlight = 0;
  let peak = 0;
  const { fetch } = mockFetch(async (c) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return ready((c.body as { sitekey: string }).sitekey);
  });
  await runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), entries(12), { concurrency: 3, solveOptions: { sleep: noSleep } });
  assert.equal(peak, 3);
});

test('budget stop: no new submissions once spend reaches maxSpendUsd', async () => {
  const { fetch, calls } = mockFetch((c) => ready((c.body as { sitekey: string }).sitekey, '0.01'));
  const { summary, items } = await runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), entries(10), {
    concurrency: 1,
    maxSpendUsd: 0.03,
    solveOptions: { sleep: noSleep },
  });
  assert.equal(calls.length, 3);
  assert.equal(summary.solved, 3);
  assert.equal(summary.skipped, 7);
  assert.equal(summary.totalCostUsd, 0.03);
  assert.equal(summary.stoppedReason, 'budget_reached');
  assert.equal(items[9]!.errorCode, 'budget_reached');
});

test('insufficient_balance stops further submissions but does not throw', async () => {
  const { fetch, calls } = mockFetch(() => ({ status: 402, body: { error: { code: 'insufficient_balance', message: 'Balance too low' } } }));
  const { summary } = await runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), entries(5), { concurrency: 1, solveOptions: { sleep: noSleep } });
  assert.equal(calls.length, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 4);
  assert.equal(summary.stoppedReason, 'insufficient_balance');
});

test('invalid_api_key throws FatalApiKeyError with redacted message', async () => {
  const { fetch } = mockFetch(() => ({ status: 401, body: { error: { code: 'invalid_api_key', message: `Key ${KEY} is invalid` } } }));
  await assert.rejects(
    runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), entries(3), {
      concurrency: 1,
      solveOptions: { sleep: noSleep },
      redact: (t) => t.split(KEY).join('***'),
    }),
    (e: unknown) => {
      assert.ok(e instanceof FatalApiKeyError);
      assert.ok(!e.message.includes(KEY));
      assert.equal(e.summary.failed, 1);
      assert.equal(e.summary.skipped, 2);
      assert.ok(!JSON.stringify(e.items).includes(KEY));
      return true;
    },
  );
});

test('dataset items never contain proxy credentials or the API key', async () => {
  const { fetch } = mockFetch((c) => ready((c.body as { sitekey: string }).sitekey));
  const { items } = await runTasks(
    new CaptchaNoClient({ apiKey: KEY, fetch }),
    entries(2, { proxy: 'http://alice:hunter2@1.2.3.4:8080' }),
    { concurrency: 2, solveOptions: { sleep: noSleep } },
  );
  const s = JSON.stringify(items);
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes(KEY));
  assert.equal((items[0]!.input as { proxy: string }).proxy, 'http://***:***@1.2.3.4:8080');
});

test('poll timeout becomes a failed item, run continues', async () => {
  const { fetch } = mockFetch(() => ({ status: 202, body: { id: 'slow', type: 'turnstile', status: 'solving' } }));
  const { summary, items } = await runTasks(new CaptchaNoClient({ apiKey: KEY, fetch }), entries(1), {
    concurrency: 1,
    solveOptions: { sleep: noSleep },
  });
  assert.equal(summary.failed, 1);
  assert.equal(items[0]!.errorCode, 'poll_timeout');
  assert.equal(items[0]!.id, 'slow');
});
