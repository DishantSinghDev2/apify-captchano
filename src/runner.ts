import { CaptchaNoError, type CaptchaNoClient, type SolveAndWaitOptions, type Task } from './client.js';
import type { TaskEntry } from './input.js';
import { preview, sanitizeTaskEcho, type TaskEcho } from './mask.js';

export type ResultStatus = 'ready' | 'failed' | 'skipped' | 'invalid';

/** One dataset item per input task. */
export interface ResultItem {
  taskIndex: number;
  id: string | null;
  type: string | null;
  status: ResultStatus;
  token: string | null;
  cookie: string | null;
  text: string | null;
  /** User agent the solution is bound to, if returned. */
  solutionUserAgent: string | null;
  /** Truncated token / cookie / text for table views. */
  solutionPreview: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** USD charged by CaptchaNo for this task (0 when not billed). */
  costUsd: number;
  /** Raw decimal string returned by the API. */
  cost: string | null;
  billedFrom: string | null;
  solveTime: number | null;
  createdAt: string | null;
  attempts: number;
  polls: number;
  finishedAt: string;
  /** Echo of the task input with proxy credentials masked and the API key never included. */
  input: TaskEcho | Record<string, unknown>;
}

export interface RunSummary {
  total: number;
  solved: number;
  failed: number;
  skipped: number;
  invalid: number;
  totalCostUsd: number;
  stoppedReason: string | null;
}

export interface RunOptions {
  concurrency: number;
  maxSpendUsd?: number;
  solveOptions?: SolveAndWaitOptions;
  onResult?: (item: ResultItem, summary: RunSummary) => Promise<void> | void;
  redact?: (text: string) => string;
}

/** Thrown out of runTasks when the key is rejected; the Actor fails the run on this. */
export class FatalApiKeyError extends Error {
  readonly summary: RunSummary;
  readonly items: ResultItem[];
  constructor(message: string, summary: RunSummary, items: ResultItem[]) {
    super(message);
    this.name = 'FatalApiKeyError';
    this.summary = summary;
    this.items = items;
  }
}

/** Sum USD amounts in integer nano-dollars to avoid float drift. */
const toNano = (usd: number) => Math.round(usd * 1e9);
const fromNano = (n: number) => n / 1e9;

export function parseCost(cost: string | number | undefined | null): number {
  if (cost === undefined || cost === null || cost === '') return 0;
  const n = typeof cost === 'number' ? cost : Number.parseFloat(cost);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function baseItem(entry: TaskEntry): Omit<ResultItem, 'status'> {
  return {
    taskIndex: entry.index,
    id: null,
    type: entry.request?.type ?? (typeof entry.raw.type === 'string' ? entry.raw.type : null),
    token: null,
    cookie: null,
    text: null,
    solutionUserAgent: null,
    solutionPreview: null,
    errorCode: null,
    errorMessage: null,
    costUsd: 0,
    cost: null,
    billedFrom: null,
    solveTime: null,
    createdAt: null,
    attempts: 0,
    polls: 0,
    finishedAt: new Date().toISOString(),
    input: sanitizeTaskEcho(entry.request ?? (entry.raw as never)),
  };
}

export function itemFromTask(entry: TaskEntry, task: Task, attempts: number, polls: number): ResultItem {
  const s = task.solution ?? {};
  const status: ResultStatus = task.status === 'ready' ? 'ready' : 'failed';
  return {
    ...baseItem(entry),
    id: task.id,
    type: task.type ?? entry.request?.type ?? null,
    status,
    token: s.token ?? null,
    cookie: s.cookie ?? null,
    text: s.text ?? null,
    solutionUserAgent: s.userAgent ?? null,
    solutionPreview: preview(s.token ?? s.cookie ?? s.text) ?? null,
    errorCode: task.status === 'ready' ? null : (task.error?.code ?? (task.status === 'solving' ? 'poll_timeout' : 'unsolvable')),
    errorMessage: task.status === 'ready' ? null : (task.error?.message ?? null),
    costUsd: parseCost(task.cost),
    cost: task.cost ?? null,
    billedFrom: task.billedFrom ?? null,
    solveTime: typeof task.solveTime === 'number' ? task.solveTime : null,
    createdAt: task.createdAt ?? null,
    attempts,
    polls,
  };
}

/**
 * Run tasks with bounded concurrency.
 * - Invalid tasks are reported (status "invalid") without calling the API.
 * - Once total cost >= maxSpendUsd, no new tasks are submitted (remaining → "skipped", budget_reached).
 *   Tasks already in flight still finish, so spend can exceed the budget by at most (concurrency − 1) solves.
 * - insufficient_balance stops new submissions (remaining → "skipped").
 * - invalid_api_key stops everything and throws FatalApiKeyError.
 */
export async function runTasks(client: CaptchaNoClient, entries: TaskEntry[], options: RunOptions): Promise<{ summary: RunSummary; items: ResultItem[] }> {
  const redact = options.redact ?? ((t: string) => t);
  const summary: RunSummary = { total: entries.length, solved: 0, failed: 0, skipped: 0, invalid: 0, totalCostUsd: 0, stoppedReason: null };
  const items: ResultItem[] = new Array(entries.length);
  let spentNano = 0;
  let stop: { code: string; message: string } | null = null;
  let fatal: string | null = null;
  let next = 0;

  const record = async (item: ResultItem) => {
    items[item.taskIndex] = item;
    spentNano += toNano(item.costUsd);
    summary.totalCostUsd = fromNano(spentNano);
    if (item.status === 'ready') summary.solved += 1;
    else if (item.status === 'failed') summary.failed += 1;
    else if (item.status === 'skipped') summary.skipped += 1;
    else summary.invalid += 1;
    await options.onResult?.(item, summary);
  };

  const budgetReached = () => options.maxSpendUsd !== undefined && spentNano >= toNano(options.maxSpendUsd);

  const worker = async () => {
    for (;;) {
      const i = next;
      if (i >= entries.length) return;
      next += 1;
      const entry = entries[i]!;

      if (!entry.request) {
        await record({ ...baseItem(entry), status: 'invalid', errorCode: 'invalid_input', errorMessage: entry.errors.join(' ') });
        continue;
      }
      if (!stop && budgetReached()) {
        stop = { code: 'budget_reached', message: `Budget of $${options.maxSpendUsd} reached; task not submitted.` };
        summary.stoppedReason = 'budget_reached';
      }
      if (stop) {
        await record({ ...baseItem(entry), status: 'skipped', errorCode: stop.code, errorMessage: stop.message });
        continue;
      }

      try {
        const { task, attempts, polls } = await client.solveAndWait(entry.request, options.solveOptions);
        await record(itemFromTask(entry, task, attempts, polls));
      } catch (err) {
        const e = err instanceof CaptchaNoError ? err : new CaptchaNoError('network_error', err instanceof Error ? err.message : String(err));
        const item: ResultItem = {
          ...(e.task ? itemFromTask(entry, e.task, 1, 0) : baseItem(entry)),
          status: 'failed',
          errorCode: e.code,
          errorMessage: redact(e.message),
        };
        await record(item);
        if (e.code === 'invalid_api_key') {
          fatal = redact(e.message);
          stop = { code: 'invalid_api_key', message: 'Not submitted: the API key was rejected.' };
          summary.stoppedReason = 'invalid_api_key';
        } else if (e.code === 'insufficient_balance' && !stop) {
          stop = { code: 'insufficient_balance', message: 'Not submitted: CaptchaNo balance is insufficient. Top up at https://captchano.com.' };
          summary.stoppedReason = 'insufficient_balance';
        }
      }
    }
  };

  const n = Math.max(1, Math.min(options.concurrency, entries.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));

  if (fatal !== null) throw new FatalApiKeyError(fatal, summary, items);
  return { summary, items };
}
