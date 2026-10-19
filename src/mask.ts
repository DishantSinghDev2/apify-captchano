import type { ProxyInput, SolveRequest } from './client.js';

/** "cn-abcdef1234567890" -> "cn-***7890". Never returns the full key. */
export function maskApiKey(key: string | undefined | null): string {
  if (!key) return '(none)';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

const SECRET_OBJECT_KEYS = /^(pass(word)?|username|user|login|auth|credentials?)$/i;

/** Strip credentials from a proxy URL or object. "http://u:p@h:1" -> "http://***:***@h:1". */
export function maskProxy(proxy: ProxyInput | undefined | null): ProxyInput | undefined {
  if (proxy === undefined || proxy === null) return undefined;
  if (typeof proxy === 'string') {
    // Works for http://, socks4://, socks5:// and scheme-less "user:pass@host:port".
    return proxy.replace(/^([a-z0-9+.-]+:\/\/)?([^@/]+)@/i, (_m, scheme: string | undefined) => `${scheme ?? ''}***:***@`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(proxy)) {
    if (SECRET_OBJECT_KEYS.test(k)) out[k] = '***';
    else if (typeof v === 'string' && /@/.test(v) && /:\/\//.test(v)) out[k] = maskProxy(v);
    else out[k] = v;
  }
  return out;
}

/** Collect secret substrings (API key, proxy passwords/usernames) so they can be scrubbed from any log line. */
export function collectSecrets(apiKey: string | undefined, tasks: Array<Partial<SolveRequest>>): string[] {
  const secrets = new Set<string>();
  if (apiKey) secrets.add(apiKey);
  for (const t of tasks) {
    const p = t.proxy;
    if (typeof p === 'string') {
      const m = /^(?:[a-z0-9+.-]+:\/\/)?([^@/]+)@/i.exec(p);
      if (m?.[1]) {
        const [user, ...rest] = m[1].split(':');
        const pass = rest.join(':');
        if (pass && pass.length >= 3) secrets.add(pass);
        if (user && user.length >= 6) secrets.add(user);
        secrets.add(m[1]);
      }
    } else if (p && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) {
        if (SECRET_OBJECT_KEYS.test(k) && typeof v === 'string' && v.length >= 3) secrets.add(v);
      }
    }
  }
  // Longest first so "user:pass" is replaced before "pass".
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Returns a function that replaces every secret occurrence with "***". */
export function createRedactor(secrets: string[]): (text: string) => string {
  return (text: string) => {
    let out = text;
    for (const s of secrets) {
      if (s) out = out.split(s).join('***');
    }
    return out;
  };
}

export interface TaskEcho extends Omit<SolveRequest, 'proxy' | 'body'> {
  proxy?: ProxyInput;
  body?: string;
}

/** Copy of a task safe to store in the dataset: proxy credentials masked, base64 image summarised. */
export function sanitizeTaskEcho(task: Partial<SolveRequest>): TaskEcho {
  const { proxy, body, ...rest } = task;
  const echo: TaskEcho = { ...(rest as Omit<SolveRequest, 'proxy' | 'body'>) };
  if (proxy !== undefined) echo.proxy = maskProxy(proxy);
  if (typeof body === 'string') echo.body = `[base64 image, ${body.length} chars]`;
  // Never echo anything that looks like an API key that slipped into a task object.
  for (const key of Object.keys(echo) as Array<keyof TaskEcho>) {
    if (/^(apiKey|api_key|key|token|authorization)$/i.test(String(key))) delete echo[key];
  }
  return echo;
}

/** First n characters + ellipsis, for overview tables. */
export function preview(value: string | undefined, n = 48): string | undefined {
  if (value === undefined) return undefined;
  return value.length > n ? `${value.slice(0, n)}…` : value;
}
