/**
 * Small, dependency-free typed client for the CaptchaNo API (https://api.captchano.com).
 *
 * Works in any runtime with a global `fetch` (Node 18+). Reusable outside Apify:
 *
 *   import { CaptchaNoClient } from './client.js';
 *   const client = new CaptchaNoClient({ apiKey: process.env.CAPTCHANO_API_KEY! });
 *   const task = await client.solveAndWait({ type: 'turnstile', url, sitekey });
 *   console.log(task.solution?.token);
 *
 * Docs: https://captchano.com/captcha-solver-api
 */

export const DEFAULT_BASE_URL = 'https://api.captchano.com';

export const CAPTCHA_TYPES = [
  'recaptcha_v2',
  'recaptcha_v3',
  'recaptcha_enterprise',
  'turnstile',
  'datadome',
  'image',
] as const;

export type CaptchaType = (typeof CAPTCHA_TYPES)[number];

export type TaskStatus = 'solving' | 'ready' | 'failed';

export type CaptchaNoErrorCode =
  | 'invalid_api_key'
  | 'insufficient_balance'
  | 'unsupported_type'
  | 'invalid_sitekey'
  | 'proxy_required'
  | 'proxy_unreachable'
  | 'score_not_met'
  | 'unsolvable'
  | 'capacity_unavailable'
  | 'rate_limited'
  | 'task_not_found'
  | 'upstream_error'
  // Client-side codes (never returned by the API itself):
  | 'network_error'
  | 'poll_timeout'
  | 'invalid_response';

/** Proxy as a URL string ("http://user:pass@host:port", http/socks4/socks5) or an object. */
export type ProxyInput = string | Record<string, unknown>;

export interface SolveRequest {
  type: CaptchaType;
  /** Page URL. Required for every type except `image`. */
  url?: string;
  sitekey?: string;
  action?: string;
  /** reCAPTCHA v3 / Enterprise minimum score, 0.1–0.9. */
  minScore?: number;
  invisible?: boolean;
  /** Turnstile cData. */
  cData?: string;
  /** Turnstile pageData. */
  pageData?: string;
  /** DataDome challenge URL. Required for `datadome`. */
  challengeUrl?: string;
  /** Base64 image. Required for `image`. */
  body?: string;
  userAgent?: string;
  /** Required for `datadome`. */
  proxy?: ProxyInput;
}

export interface Solution {
  token?: string;
  cookie?: string;
  text?: string;
  userAgent?: string;
}

export interface ApiError {
  code: CaptchaNoErrorCode | string;
  message: string;
}

export interface Task {
  id: string;
  type: CaptchaType | string;
  status: TaskStatus;
  solution?: Solution;
  error?: ApiError;
  /** USD, decimal string, e.g. "0.00285". Present on billed solves. */
  cost?: string;
  billedFrom?: string;
  solveTime?: number;
  /** Unix epoch milliseconds, as the API returns it. */
  createdAt?: number | string;
}

export interface Balance {
  balance: string | number;
  currency: 'USD' | string;
}

export class CaptchaNoError extends Error {
  readonly code: CaptchaNoErrorCode | string;
  readonly httpStatus: number | undefined;
  readonly task: Task | undefined;

  constructor(code: string, message: string, httpStatus?: number, task?: Task) {
    super(message);
    this.name = 'CaptchaNoError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.task = task;
  }

  /** True for errors worth retrying after a backoff. */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'capacity_unavailable' || this.httpStatus === 429;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CaptchaNoClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Extra milliseconds allowed on top of `wait` before a request is aborted. Default 30 000. */
  requestTimeoutPaddingMs?: number;
  userAgent?: string;
}

export interface SolveAndWaitOptions {
  /** Seconds the API may block on POST /v1/solve (0–120). 0 = return immediately and poll. Default 60. */
  waitSeconds?: number;
  /** Poll interval for GET /v1/task/{id} after a 202. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Give up polling after this long. Default 180 000 ms. */
  pollTimeoutMs?: number;
  /** Retries for rate_limited / capacity_unavailable on submit. Default 3. */
  maxRetries?: number;
  /** Base backoff; attempt n waits base * 2^(n-1). Default 2000 ms. */
  retryBaseDelayMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry. */
  onRetry?: (info: { attempt: number; delayMs: number; error: CaptchaNoError }) => void;
}

export interface SolveAndWaitResult {
  task: Task;
  /** Number of POST /v1/solve attempts made (1 = no retries). */
  attempts: number;
  /** Number of GET /v1/task polls made. */
  polls: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const MAX_WAIT_SECONDS = 120;

export class CaptchaNoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly paddingMs: number;
  private readonly userAgent: string | undefined;

  constructor(options: CaptchaNoClientOptions) {
    if (!options.apiKey) throw new CaptchaNoError('invalid_api_key', 'An API key is required.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.paddingMs = options.requestTimeoutPaddingMs ?? 30_000;
    this.userAgent = options.userAgent;
  }

  /** POST /v1/solve. Returns the task (ready, solving or failed). Throws CaptchaNoError for HTTP errors other than 422. */
  async solve(request: SolveRequest, waitSeconds = 0): Promise<Task> {
    const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(waitSeconds)));
    const path = wait > 0 ? `/v1/solve?wait=${wait}` : '/v1/solve';
    return this.request<Task>('POST', path, request, wait * 1000 + this.paddingMs, true);
  }

  /** GET /v1/task/{id}. */
  async getTask(id: string): Promise<Task> {
    return this.request<Task>('GET', `/v1/task/${encodeURIComponent(id)}`, undefined, this.paddingMs, true);
  }

  /** GET /v1/balance. */
  async getBalance(): Promise<Balance> {
    return this.request<Balance>('GET', '/v1/balance', undefined, this.paddingMs, false);
  }

  /**
   * Submit a task and return once it is ready or failed:
   * - retries rate_limited / capacity_unavailable with exponential backoff (default max 3 retries);
   * - on 202 polls GET /v1/task/{id} every 5 s for up to 180 s.
   * A failed solve (422) resolves with `task.status === 'failed'`; other API errors throw CaptchaNoError.
   */
  async solveAndWait(request: SolveRequest, options: SolveAndWaitOptions = {}): Promise<SolveAndWaitResult> {
    const sleep = options.sleep ?? defaultSleep;
    const maxRetries = options.maxRetries ?? 3;
    const baseDelay = options.retryBaseDelayMs ?? 2000;
    const pollInterval = options.pollIntervalMs ?? 5000;
    const pollTimeout = options.pollTimeoutMs ?? 180_000;
    const waitSeconds = options.waitSeconds ?? 60;

    let attempts = 0;
    let task: Task | undefined;
    for (;;) {
      attempts += 1;
      try {
        task = await this.solve(request, waitSeconds);
      } catch (err) {
        if (err instanceof CaptchaNoError && err.retryable && attempts <= maxRetries) {
          const delayMs = baseDelay * 2 ** (attempts - 1);
          options.onRetry?.({ attempt: attempts, delayMs, error: err });
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
      // A 422 can carry a retryable error code (e.g. capacity_unavailable) — failed solves are never billed.
      if (
        task.status === 'failed' &&
        (task.error?.code === 'capacity_unavailable' || task.error?.code === 'rate_limited') &&
        attempts <= maxRetries
      ) {
        const delayMs = baseDelay * 2 ** (attempts - 1);
        options.onRetry?.({
          attempt: attempts,
          delayMs,
          error: new CaptchaNoError(task.error.code, task.error.message, 422, task),
        });
        await sleep(delayMs);
        continue;
      }
      break;
    }

    let polls = 0;
    let waited = 0;
    while (task.status === 'solving') {
      if (waited >= pollTimeout) {
        throw new CaptchaNoError(
          'poll_timeout',
          `Task ${task.id} still solving after ${Math.round(pollTimeout / 1000)} s of polling.`,
          undefined,
          task,
        );
      }
      await sleep(pollInterval);
      waited += pollInterval;
      polls += 1;
      try {
        task = await this.getTask(task.id);
      } catch (err) {
        // Transient poll errors: keep polling until the timeout.
        if (err instanceof CaptchaNoError && (err.retryable || err.code === 'network_error' || err.code === 'upstream_error')) {
          continue;
        }
        throw err;
      }
    }
    return { task, attempts, polls };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    taskShaped: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.userAgent) headers['User-Agent'] = this.userAgent;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CaptchaNoError('network_error', `Request to ${path.split('?')[0]} failed: ${reason}`);
    }

    let data: unknown;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    // Task-shaped responses: 200 ready, 202 solving, 422 failed — all returned as a Task.
    if (taskShaped && (res.status === 200 || res.status === 202 || res.status === 422) && isTask(data)) {
      return data as T;
    }
    if (res.ok && data !== undefined && !taskShaped) return data as T;

    const apiError = extractError(data);
    const code = apiError?.code ?? codeFromStatus(res.status);
    const message = apiError?.message ?? `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    throw new CaptchaNoError(code, message, res.status, isTask(data) ? data : undefined);
  }
}

function isTask(value: unknown): value is Task {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Task).id === 'string' &&
    typeof (value as Task).status === 'string'
  );
}

function extractError(value: unknown): ApiError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const err = (value as { error?: unknown }).error;
  if (typeof err === 'object' && err !== null && typeof (err as ApiError).code === 'string') {
    return { code: (err as ApiError).code, message: String((err as ApiError).message ?? (err as ApiError).code) };
  }
  if (typeof err === 'string') return { code: err, message: err };
  return undefined;
}

function codeFromStatus(status: number): string {
  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 402) return 'insufficient_balance';
  if (status === 404) return 'task_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'invalid_response';
}
