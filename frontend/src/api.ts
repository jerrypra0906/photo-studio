/** API client: access token in memory, refresh via httpOnly cookie (TD §3.4). Same-origin /api/v1. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields: Record<string, string> = {}, public data: any = {}) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onAuthLost: () => void = () => undefined;

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const setOnAuthLost = (fn: () => void) => { onAuthLost = fn; };

let refreshInFlight: Promise<any | null> | null = null;

/**
 * One refresh at a time: the token rotates, so parallel calls would present an already-rotated token.
 * Only a 401 means the session is over; a network error or 5xx (e.g. the API restarting) is retried
 * so a deploy doesn't sign the owner out.
 */
export function refreshSession(): Promise<any | null> {
  refreshInFlight ??= (async () => {
    let wait = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, wait || 800 * attempt));
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
      // rate limited: wait as long as the server asks (capped), the session itself is still valid
      wait = r?.status === 429 ? Math.min(15, Number(r.headers.get('retry-after')) || 3) * 1000 : 0;
      if (!r || r.status >= 500 || r.status === 429) continue;
      if (!r.ok) return null;
      const data = await r.json();
      accessToken = data.accessToken;
      return data.user;
    }
    return null;
  })().catch(() => null).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function tryRefresh() {
  refreshing ??= refreshSession().then((u) => !!u).finally(() => { refreshing = null; });
  return refreshing;
}

export async function request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<T> {
  const isForm = body instanceof FormData;
  let r: Response;
  try {
    r = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Tidak bisa terhubung — periksa koneksi');
  }
  if (r.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return request(method, path, body, headers, false);
    onAuthLost();
  }
  if (r.status === 204) return undefined as T;
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok) {
    const e = type.includes('json') ? await r.json() : { message: r.statusText };
    throw new ApiError(r.status, e.code ?? 'ERROR', e.message ?? 'Terjadi kesalahan', e.fields ?? {}, e);
  }
  if (type.includes('json')) return r.json();
  return (await r.blob()) as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('POST', p, b ?? {}, h),
  patch: <T = any>(p: string, b: unknown, h?: Record<string, string>) => request<T>('PATCH', p, b, h),
  put: <T = any>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  blob: (p: string) => request<Blob>('GET', p),
};

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
