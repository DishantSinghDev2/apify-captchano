import { Actor, log } from 'apify';

import { CaptchaNoClient, CaptchaNoError } from './client.js';
import { InputError, normalizeInput, type ActorInput } from './input.js';
import { collectSecrets, createRedactor, maskApiKey } from './mask.js';
import { FatalApiKeyError, runTasks, type RunSummary } from './runner.js';

const fmtUsd = (n: number) => `$${n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.00')}`;

function statusLine(s: RunSummary): string {
  const done = s.solved + s.failed + s.skipped + s.invalid;
  return `${done}/${s.total} done — solved ${s.solved}, failed ${s.failed}` +
    `${s.skipped ? `, skipped ${s.skipped}` : ''}${s.invalid ? `, invalid ${s.invalid}` : ''} — spent ${fmtUsd(s.totalCostUsd)}`;
}

await Actor.init();

const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
let redact: (t: string) => string = createRedactor(collectSecrets(rawInput.apiKey, []));
let taskCount = 0;

// No key: finish cleanly with one explanatory item instead of failing. This is
// also what Apify's daily default-input health check sees.
if (!(typeof rawInput.apiKey === 'string' && rawInput.apiKey.trim())) {
  const message = 'No CaptchaNo API key was provided, so nothing was solved. Create a key at https://captchano.com/dashboard/keys (new accounts get free credit) and pass it as "apiKey".';
  await Actor.pushData({
    taskIndex: 0,
    status: 'skipped',
    type: null,
    errorCode: 'missing_api_key',
    errorMessage: message,
    finishedAt: new Date().toISOString(),
  });
  await Actor.setValue('OUTPUT', { total: 0, solved: 0, failed: 0, skipped: 1, invalid: 0, totalCostUsd: 0, stoppedReason: 'missing_api_key' });
  log.warning(message);
  await Actor.exit(message);
}

try {
  const input = normalizeInput(rawInput);
  taskCount = input.tasks.length;
  redact = createRedactor(
    collectSecrets(input.apiKey, [
      ...input.tasks.map((t) => (t.request ?? t.raw) as Record<string, never>),
    ]),
  );

  const client = new CaptchaNoClient({
    apiKey: input.apiKey,
    userAgent: 'captchano-apify-actor/1.0',
    // For testing against a local or staging API only.
    baseUrl: process.env.CAPTCHANO_API_BASE || undefined,
  });
  log.info(`CaptchaNo key ${maskApiKey(input.apiKey)} — ${input.tasks.length} task(s), concurrency ${input.concurrency}, wait ${input.waitSeconds}s` +
    `${input.maxSpendUsd !== undefined ? `, budget ${fmtUsd(input.maxSpendUsd)}` : ''}`);

  // Fail fast on a bad key; a transient balance error is only a warning.
  try {
    const bal = await client.getBalance();
    log.info(`CaptchaNo balance: ${bal.balance} ${bal.currency}`);
  } catch (err) {
    if (err instanceof CaptchaNoError && err.code === 'invalid_api_key') throw err;
    log.warning(`Could not read balance (${err instanceof CaptchaNoError ? err.code : 'error'}): ${redact(err instanceof Error ? err.message : String(err))}`);
  }

  await Actor.setStatusMessage(`Solving ${input.tasks.length} task(s)…`);

  const { summary } = await runTasks(client, input.tasks, {
    concurrency: input.concurrency,
    maxSpendUsd: input.maxSpendUsd,
    redact,
    solveOptions: {
      waitSeconds: input.waitSeconds,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warning(`Retry ${attempt}/3 after ${error.code}, waiting ${Math.round(delayMs / 1000)}s`),
    },
    onResult: async (item, s) => {
      await Actor.pushData(item);
      const what = item.status === 'ready' ? 'solved' : `${item.status} (${item.errorCode})`;
      log.info(`Task #${item.taskIndex} ${item.type ?? ''} ${what}${item.id ? ` id=${item.id}` : ''}${item.costUsd ? ` cost=${item.cost}` : ''}`);
      await Actor.setStatusMessage(statusLine(s));
    },
  });

  await Actor.setValue('OUTPUT', summary);
  await Actor.setStatusMessage(statusLine(summary), { isStatusMessageTerminal: true });
  log.info(`Finished: ${JSON.stringify(summary)}`);
  await Actor.exit();
} catch (err) {
  if (err instanceof FatalApiKeyError) {
    await Actor.setValue('OUTPUT', err.summary);
    await Actor.fail(`invalid_api_key: ${redact(err.message)} — check your CaptchaNo API key at https://captchano.com.`);
  } else if (err instanceof CaptchaNoError && err.code === 'invalid_api_key') {
    const summary: RunSummary = {
      total: taskCount, solved: 0, failed: 0, skipped: taskCount, invalid: 0, totalCostUsd: 0, stoppedReason: 'invalid_api_key',
    };
    await Actor.setValue('OUTPUT', summary);
    await Actor.fail(`invalid_api_key: ${redact(err.message)} — check your CaptchaNo API key at https://captchano.com.`);
  } else if (err instanceof InputError) {
    await Actor.fail(`${err.code}: ${redact(err.message)}`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    await Actor.fail(`Unexpected error: ${redact(message)}`);
  }
}
