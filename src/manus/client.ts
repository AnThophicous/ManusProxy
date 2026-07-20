import { getManusAuth, type ManusAuth } from '../services/playwright.ts';

const API_BASE = 'https://api.manus.im';

export type ManusRpcResult = {
  ok: boolean;
  status: number;
  url: string;
  body: unknown;
  raw: string;
};

function buildHeaders(auth: ManusAuth, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: '*/*',
    'content-type': 'application/json',
    origin: auth.extras.origin || 'https://manus.im',
    referer: auth.extras.referer || 'https://manus.im/',
    'user-agent': auth.userAgent || 'Mozilla/5.0',
  };

  if (auth.authorization) headers.authorization = auth.authorization;
  if (auth.cookie) headers.cookie = auth.cookie;

  for (const [k, v] of Object.entries(auth.extras)) {
    if (k === 'content-type') continue;
    if (v) headers[k] = v;
  }

  if (extra) Object.assign(headers, extra);
  return headers;
}

/** Low-level Connect/gRPC-web style POST used by the Manus web app */
export async function manusRpc(
  serviceMethod: string,
  body: unknown = {},
  accountId?: string | null,
  signal?: AbortSignal
): Promise<ManusRpcResult> {
  const auth = await getManusAuth(accountId);
  const path = serviceMethod.startsWith('/')
    ? serviceMethod
    : `/${serviceMethod}`;
  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: JSON.stringify(body ?? {}),
    signal,
  });

  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // keep raw
  }

  return {
    ok: res.ok,
    status: res.status,
    url,
    body: parsed,
    raw,
  };
}

export async function getUserInfo(accountId?: string | null): Promise<ManusRpcResult> {
  return manusRpc('user.v1.UserService/UserInfo', {}, accountId);
}

export async function getAvailableCredits(accountId?: string | null): Promise<ManusRpcResult> {
  return manusRpc('user.v1.UserService/GetAvailableCredits', {}, accountId);
}

export async function getUserClientConfig(accountId?: string | null): Promise<ManusRpcResult> {
  return manusRpc('user.v1.UserService/GetUserClientConfig', {}, accountId);
}

/**
 * Create / run a session task via web API.
 * Endpoints are refined after live capture — these are the common Manus patterns.
 */
export async function createSession(
  prompt: string,
  accountId?: string | null,
  opts?: { mode?: string; signal?: AbortSignal }
): Promise<ManusRpcResult> {
  // Primary candidate (web app). Capture script will confirm the real shape.
  const candidates: Array<{ method: string; body: unknown }> = [
    {
      method: 'session.v1.SessionService/CreateSession',
      body: {
        prompt,
        mode: opts?.mode || 'chat',
      },
    },
    {
      method: 'session.v1.SessionService/CreateSession',
      body: {
        message: prompt,
        taskMode: opts?.mode || 'chat',
      },
    },
    {
      method: 'chat.v1.ChatService/CreateChat',
      body: { message: prompt },
    },
  ];

  let last: ManusRpcResult | null = null;
  for (const c of candidates) {
    last = await manusRpc(c.method, c.body, accountId, opts?.signal);
    if (last.ok) return last;
    // 404/501 = wrong method name; try next. 401 = auth dead.
    if (last.status === 401 || last.status === 403) return last;
  }
  return last!;
}

export async function sendSessionMessage(
  sessionId: string,
  message: string,
  accountId?: string | null,
  signal?: AbortSignal
): Promise<ManusRpcResult> {
  const candidates: Array<{ method: string; body: unknown }> = [
    {
      method: 'session.v1.SessionService/SendMessage',
      body: { sessionId, message },
    },
    {
      method: 'session.v1.SessionService/SendMessage',
      body: { session_id: sessionId, content: message },
    },
  ];

  let last: ManusRpcResult | null = null;
  for (const c of candidates) {
    last = await manusRpc(c.method, c.body, accountId, signal);
    if (last.ok) return last;
    if (last.status === 401 || last.status === 403) return last;
  }
  return last!;
}

export function extractTextFromManusBody(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;

  const walk = (v: unknown, depth = 0): string[] => {
    if (depth > 8 || v == null) return [];
    if (typeof v === 'string') {
      // skip pure ids/tokens
      if (v.length > 2 && !/^[a-f0-9-]{20,}$/i.test(v)) return [v];
      return [];
    }
    if (Array.isArray(v)) return v.flatMap((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const prefer = ['text', 'content', 'message', 'answer', 'output', 'result', 'markdown'];
      const out: string[] = [];
      for (const k of prefer) {
        if (k in o) out.push(...walk(o[k], depth + 1));
      }
      for (const [k, val] of Object.entries(o)) {
        if (prefer.includes(k)) continue;
        if (/id|token|url|key|hash/i.test(k)) continue;
        out.push(...walk(val, depth + 1));
      }
      return out;
    }
    return [];
  };

  const parts = walk(body).filter((s) => s.trim().length > 0);
  // Prefer longest meaningful chunk
  parts.sort((a, b) => b.length - a.length);
  return parts[0] || JSON.stringify(body).slice(0, 2000);
}
