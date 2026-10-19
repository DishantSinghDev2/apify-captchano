import { CAPTCHA_TYPES, MAX_WAIT_SECONDS, type CaptchaType, type ProxyInput, type SolveRequest } from './client.js';

export interface ActorInput {
  apiKey?: string;
  tasks?: unknown;
  type?: string;
  url?: string;
  sitekey?: string;
  action?: string;
  minScore?: number | null;
  invisible?: boolean | null;
  challengeUrl?: string;
  proxy?: string;
  userAgent?: string;
  waitSeconds?: number;
  concurrency?: number;
  maxSpendUsd?: number | null;
}

export interface TaskEntry {
  index: number;
  /** Clean request (only known API fields) — or undefined if invalid. */
  request?: SolveRequest;
  /** Raw (possibly invalid) task, used for echo when invalid. */
  raw: Record<string, unknown>;
  errors: string[];
}

export interface NormalizedInput {
  apiKey: string;
  tasks: TaskEntry[];
  waitSeconds: number;
  concurrency: number;
  maxSpendUsd: number | undefined;
}

export class InputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

export const MAX_CONCURRENCY = 50;
export const DEFAULT_WAIT_SECONDS = 60;
export const DEFAULT_CONCURRENCY = 5;

const STRING_FIELDS = ['url', 'sitekey', 'action', 'cData', 'pageData', 'challengeUrl', 'body', 'userAgent'] as const;

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidProxyString(value: string): boolean {
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return ['http:', 'https:', 'socks4:', 'socks5:'].includes(u.protocol) && !!u.hostname && !!u.port;
  } catch {
    return false;
  }
}

/** Validate one task object and build a clean SolveRequest containing only known API fields. */
export function validateTask(raw: unknown, index: number): TaskEntry {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { index, raw: { value: raw as unknown }, errors: ['Task must be a JSON object.'] };
  }
  const t = raw as Record<string, unknown>;
  const req: Partial<SolveRequest> = {};

  if (typeof t.type !== 'string' || !(CAPTCHA_TYPES as readonly string[]).includes(t.type)) {
    errors.push(`"type" must be one of: ${CAPTCHA_TYPES.join(', ')}.`);
  } else {
    req.type = t.type as CaptchaType;
  }

  for (const f of STRING_FIELDS) {
    const v = t[f];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') errors.push(`"${f}" must be a string.`);
    else req[f] = v.trim();
  }

  if (t.minScore !== undefined && t.minScore !== null) {
    if (typeof t.minScore !== 'number' || Number.isNaN(t.minScore) || t.minScore < 0.1 || t.minScore > 0.9) {
      errors.push('"minScore" must be a number between 0.1 and 0.9.');
    } else req.minScore = t.minScore;
  }
  if (t.invisible !== undefined && t.invisible !== null) {
    if (typeof t.invisible !== 'boolean') errors.push('"invisible" must be true or false.');
    else req.invisible = t.invisible;
  }
  if (t.proxy !== undefined && t.proxy !== null && t.proxy !== '') {
    if (typeof t.proxy === 'string') {
      if (!isValidProxyString(t.proxy.trim())) {
        errors.push('"proxy" must look like http://user:pass@host:port (http, socks4 or socks5).');
      } else req.proxy = t.proxy.trim();
    } else if (typeof t.proxy === 'object' && !Array.isArray(t.proxy)) {
      req.proxy = t.proxy as ProxyInput;
    } else errors.push('"proxy" must be a URL string or an object.');
  }

  if (req.type && req.type !== 'image') {
    if (!req.url) errors.push(`"url" (the page URL) is required for type "${req.type}".`);
    else if (!isHttpUrl(req.url)) errors.push('"url" must be an http(s) URL.');
  }
  if (req.type === 'image' && !req.body) errors.push('"body" (base64 image) is required for type "image".');
  if (req.type === 'datadome') {
    if (!req.challengeUrl) errors.push('"challengeUrl" is required for type "datadome".');
    if (!req.proxy) errors.push('"proxy" is required for type "datadome" (error code proxy_required).');
  }
  if (req.challengeUrl && !isHttpUrl(req.challengeUrl)) errors.push('"challengeUrl" must be an http(s) URL.');

  return {
    index,
    raw: t,
    errors,
    request: errors.length === 0 ? (req as SolveRequest) : undefined,
  };
}

function clampInt(value: unknown, def: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError('invalid_input', `"${name}" must be a number.`);
  }
  const n = Math.floor(value);
  if (n < min || n > max) throw new InputError('invalid_input', `"${name}" must be between ${min} and ${max}.`);
  return n;
}

/** Validate the whole Actor input. Throws InputError for run-level problems; per-task problems are returned in entries. */
export function normalizeInput(input: ActorInput | null | undefined): NormalizedInput {
  if (!input || typeof input !== 'object') throw new InputError('invalid_input', 'Input is missing.');

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey) throw new InputError('invalid_api_key', 'Input "apiKey" is required. Get a key at https://captchano.com.');
  if (!apiKey.startsWith('cn-')) {
    throw new InputError('invalid_api_key', 'Input "apiKey" does not look like a CaptchaNo key (keys start with "cn-").');
  }

  const waitSeconds = clampInt(input.waitSeconds, DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS, 'waitSeconds');
  const concurrency = clampInt(input.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY, 'concurrency');

  let maxSpendUsd: number | undefined;
  if (input.maxSpendUsd !== undefined && input.maxSpendUsd !== null) {
    if (typeof input.maxSpendUsd !== 'number' || !Number.isFinite(input.maxSpendUsd) || input.maxSpendUsd <= 0) {
      throw new InputError('invalid_input', '"maxSpendUsd" must be a positive number of US dollars.');
    }
    maxSpendUsd = input.maxSpendUsd;
  }

  let rawTasks: unknown[];
  if (input.tasks !== undefined && input.tasks !== null && !Array.isArray(input.tasks)) {
    throw new InputError('invalid_input', '"tasks" must be an array of task objects.');
  }
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    rawTasks = input.tasks;
  } else if (input.type) {
    const single: Record<string, unknown> = { type: input.type };
    for (const f of ['url', 'sitekey', 'action', 'minScore', 'invisible', 'challengeUrl', 'proxy', 'userAgent'] as const) {
      const v = input[f];
      if (v !== undefined && v !== null && v !== '') single[f] = v;
    }
    rawTasks = [single];
  } else {
    throw new InputError('invalid_input', 'Provide at least one task in "tasks", or set "type" (and "url"/"sitekey") for a single task.');
  }

  const tasks = rawTasks.map((t, i) => validateTask(t, i));
  return { apiKey, tasks, waitSeconds, concurrency, maxSpendUsd };
}
