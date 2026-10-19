import type { FetchLike } from '../src/client.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (call: Call, n: number) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** Build a fake fetch that records calls and answers from `responder`. */
export function mockFetch(responder: Responder): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = await responder(call, calls.length);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, calls };
}

export const noSleep = async () => {};

export const KEY = 'cn-test0000000000000000secret';
