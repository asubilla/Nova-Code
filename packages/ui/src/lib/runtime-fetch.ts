import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { TUNNEL_PARSE_BASE } from './relay/tunnel-payloads';
import { buildRuntimeAuthHeaders } from './runtime-auth';
import { observeRuntimeAuthResponse } from './runtime-auth-expiry';
import { getRuntimeUrlResolver, type RuntimeUrlQuery } from './runtime-url';
import {
  attemptInstanceFailover,
  canAttemptInstanceFailover,
  isFailoverTriggerStatus,
  isTransientRestartResponse,
} from './instance-failover';

export interface RuntimeFetchOptions extends RequestInit {
  query?: RuntimeUrlQuery;
}

const shouldResolveApiPath = (input: string): boolean => {
  return input.startsWith('/api/') || input === '/api' || input.startsWith('/auth/') || input === '/auth' || input === '/health';
};

const getCurrentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.location.origin || '';
};

const isCurrentWindowUrl = (url: URL): boolean => {
  if (typeof window === 'undefined') return false;
  const currentOrigin = getCurrentOrigin();
  if (currentOrigin && url.origin === currentOrigin) return true;
  try {
    const current = new URL(window.location.href || currentOrigin);
    return url.protocol === current.protocol && url.host === current.host;
  } catch {
    return false;
  }
};

const isAbsoluteUrl = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

const isNgrokHost = (hostname: string): boolean =>
  /(^|\.)ngrok(?:-free)?\.(?:app|dev|io)$/i.test(hostname);

export const addRuntimeProxyHeaders = (url: string, headers: Headers): Headers => {
  try {
    if (isNgrokHost(new URL(url).hostname) && !headers.has('ngrok-skip-browser-warning')) {
      headers.set('ngrok-skip-browser-warning', 'novacode');
    }
  } catch {
    // Relative and non-HTTP runtime paths do not need proxy-specific headers.
  }
  return headers;
};

const appendRuntimeQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;
  const entries = query instanceof URLSearchParams ? Array.from(query.entries()) : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

const isActiveRuntimeServiceUrl = (url: URL): boolean => {
  try {
    const apiBase = getRuntimeUrlResolver().api('/api');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(apiBase)) return false;
    const base = new URL(apiBase);
    if (url.origin !== base.origin) return false;
    return shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
};

const shouldResolveFetchInput = (input: string): boolean => {
  if (shouldResolveApiPath(input)) return true;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return false;
  try {
    const url = new URL(input);
    return isCurrentWindowUrl(url) && shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
};

const buildRuntimeFetchUrlFromAbsolute = (input: string, query?: RuntimeUrlQuery): string => {
  try {
    const url = new URL(input);
    if (!isCurrentWindowUrl(url)) return input;
    const rewritten = buildRuntimeFetchUrl(`${url.pathname}${url.search}`, query);
    if (!isAbsoluteUrl(rewritten) && (url.protocol === 'http:' || url.protocol === 'https:')) {
      appendRuntimeQuery(url, query);
      return url.toString();
    }
    return url.hash ? `${rewritten}${url.hash}` : rewritten;
  } catch {
    return input;
  }
};

export const buildRuntimeFetchUrl = (input: string, query?: RuntimeUrlQuery): string => {
  if (input === '/health') return getRuntimeUrlResolver().health(query);
  if (input.startsWith('/auth/') || input === '/auth') return getRuntimeUrlResolver().auth(input, query);
  if (shouldResolveApiPath(input)) return getRuntimeUrlResolver().api(input, query);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return buildRuntimeFetchUrlFromAbsolute(input, query);
  return input;
};

const shouldAttachRuntimeAuth = (input: string | URL | Request): boolean => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    return shouldResolveApiPath(raw);
  }

  try {
    return isActiveRuntimeServiceUrl(new URL(raw));
  } catch {
    return false;
  }
};

// Headers API only accepts ISO-8859-1 (Latin-1) characters. Any value containing
// characters outside \u0000-\u00FF causes "Failed to construct/set 'Headers':
// String contains non ISO-8859-1 code point." Encode those values so they round-trip
// safely through the browser's Headers API. Directory hints get an explicit marker
// only when encoded, so plain ASCII paths remain compatible with routes that read
// the header directly.
export const isLatin1Safe = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const shouldEncodeHeaderValue = (_key: string, value: string): boolean => !isLatin1Safe(value);

export const sanitizeHeadersForBrowser = (init?: HeadersInit): [string, string][] | undefined => {
  if (!init) return undefined;
  // Normalize any HeadersInit shape into a plain array of entries so we can
  // safely inspect and re-encode non-Latin-1 values.
  const sourceEntries: [string, string][] = init instanceof Headers
    ? Array.from(init.entries())
    : Array.isArray(init)
      ? init
      : Object.entries(init);
  if (sourceEntries.length === 0) return undefined;
  const entries: [string, string][] = [];
  let dirty = false;
  let encodedDirectoryHint = false;
  for (const [key, value] of sourceEntries) {
    if (shouldEncodeHeaderValue(key, value)) {
      entries.push([key, encodeURIComponent(value)]);
      dirty = true;
      if (key.toLowerCase() === 'x-opencode-directory') encodedDirectoryHint = true;
    } else {
      entries.push([key, value]);
    }
  }
  if (encodedDirectoryHint) {
    entries.push(['x-opencode-directory-encoding', 'uri']);
  }
  return dirty ? entries : undefined;
};

const mergeHeaders = async (inputHeaders?: HeadersInit, initHeaders?: HeadersInit, attachAuth = true): Promise<Headers> => {
  const headers = new Headers(sanitizeHeadersForBrowser(inputHeaders) ?? inputHeaders);
  if (initHeaders) {
    new Headers(sanitizeHeadersForBrowser(initHeaders) ?? initHeaders).forEach((value, key) => headers.set(key, value));
  }
  if (!attachAuth) {
    return headers;
  }
  return buildRuntimeAuthHeaders(headers);
};

// ── Relay-mode routing ─────────────────────────────────────────────────────
// When the active runtime is a private relay, runtime HTTP does not go to the
// network: it rides the E2EE tunnel. We route exactly the same paths we would
// resolve for a network runtime (/api, /auth, /health) and attach identical
// auth headers; the bearer/url-token semantics are unchanged, only the
// transport differs. Non-runtime requests (external URLs) fall through to the
// real network fetch.
const appendPathQuery = (path: string, query?: RuntimeUrlQuery): string => {
  if (!query) return path;
  const url = new URL(path, TUNNEL_PARSE_BASE);
  appendRuntimeQuery(url, query);
  return `${url.pathname}${url.search}`;
};

const extractRelayPath = (input: string | URL | Request, query?: RuntimeUrlQuery): string | null => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    if (!shouldResolveApiPath(raw)) return null;
    return appendPathQuery(raw, query);
  }
  try {
    const url = new URL(raw);
    if (!isCurrentWindowUrl(url) || !shouldResolveApiPath(url.pathname)) return null;
    appendRuntimeQuery(url, query);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

const tryRelayFetch = async (
  input: string | URL | Request,
  requestInit: RequestInit,
  query?: RuntimeUrlQuery,
): Promise<Response | null> => {
  const relay = getActiveRelayTunnel();
  if (!relay) return null;
  const path = extractRelayPath(input, query);
  if (path === null) return null;
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  const headers = await mergeHeaders(inputHeaders, requestInit.headers, true);
  if (input instanceof Request) {
    // Forward the Request itself — the tunnel reads its method/body/signal
    // natively (incl. stream bodies). Re-wrapping as `new Request(path, input)`
    // throws on a stream body without duplex:'half'.
    return relay.fetch(input, { ...requestInit, headers });
  }
  return relay.fetch(path, { ...requestInit, headers });
};

const resolveRuntimeFetchInput = (input: string | URL | Request, query?: RuntimeUrlQuery): string | URL | Request => {
  if (typeof input === 'string') {
    return buildRuntimeFetchUrl(input, query);
  }

  if (input instanceof URL) {
    return buildRuntimeFetchUrl(input.toString(), query);
  }

  const target = buildRuntimeFetchUrl(input.url, query);
  return target === input.url ? input : new Request(target, input);
};

// ---------------------------------------------------------------------------
// In-flight read coalescing
//
// On cold start two independent data layers (the sync bootstrap and the config
// store) fire the SAME idempotent reads — providers, config, path, agents,
// project — concurrently, with no shared dedup. That saturates the single
// OpenCode process and delays everything queued behind it (e.g. createSession).
// Coalesce genuinely-concurrent identical GETs to those read endpoints so
// OpenCode does the work once; every caller gets an independent `clone()`.
//
// Scope is deliberately tight: GET only, an allowlist of read paths, never an
// event stream, and never a request carrying an AbortSignal (so one caller
// aborting can't cancel the shared fetch for the others). The entry is removed
// as soon as the request settles, so this only ever shares overlapping in-flight
// requests — it never serves a stale/cached response.
// ---------------------------------------------------------------------------
const COALESCE_READ_PATH = /\/api\/(config|path|app\/agents|agent|project|command)(\b|\/|\?|$)/;
const READ_COALESCE = new Map<string, Promise<Response>>();

const coalesceReadKey = (method: string, url: string, hasSignal: boolean): string | null => {
  if (hasSignal) return null;
  if (method !== 'GET') return null;
  if (url.includes('/event')) return null;
  if (!COALESCE_READ_PATH.test(url)) return null;
  return `GET ${url}`;
};

const isRuntimeServiceUrl = (rawUrl: string): boolean => {
  try {
    return isActiveRuntimeServiceUrl(new URL(rawUrl));
  } catch {
    return false;
  }
};

// A Request body cannot be replayed once the first attempt consumed it, so a
// request carrying one is retried from an untouched clone taken up front.
const sourceForFailoverRetry = (input: string | URL | Request): string | URL | Request | null => {
  if (input instanceof Request && input.body && !input.bodyUsed) {
    try {
      return input.clone();
    } catch {
      // A locked body means no retry — the first attempt still runs normally.
      return null;
    }
  }
  return input;
};

export const runtimeFetch = async (input: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {
  const { query, ...requestInit } = init;

  // Failover gets exactly one retry, and only from the first attempt. A relay
  // transport is an E2EE tunnel, not an address, so it never fails over.
  const relayOnEntry = getActiveRelayTunnel();
  const failoverRetrySource = !relayOnEntry && canAttemptInstanceFailover()
    ? sourceForFailoverRetry(input)
    : null;

  const attemptFetch = async (source: string | URL | Request, attempt: number): Promise<Response> => {
    // Resolve the transport once — relay tunnel or network — then apply the SAME
    // read-coalescing to both. On a relay the tunnel is bandwidth/latency-bound, so
    // deduping concurrent identical GETs matters there most.
    const relay = getActiveRelayTunnel();
    const relayPath = relay ? extractRelayPath(source, query) : null;
    const failoverEligible = !relay && relayPath === null && attempt === 0 && failoverRetrySource !== null;

    let doFetch: () => Promise<Response>;
    let url: string;
    let method: string;
    if (relay && relayPath !== null) {
      const inputHeaders = source instanceof Request ? source.headers : undefined;
      const headers = await mergeHeaders(inputHeaders, requestInit.headers, true);
      doFetch = source instanceof Request
        ? () => relay.fetch(source, { ...requestInit, headers })
        : () => relay.fetch(relayPath, { ...requestInit, headers });
      url = relayPath;
      method = String(requestInit.method ?? (source instanceof Request ? source.method : 'GET')).toUpperCase();
    } else {
      const resolvedInput = resolveRuntimeFetchInput(source, query);
      const inputHeaders = resolvedInput instanceof Request ? resolvedInput.headers : undefined;
      const headers = await mergeHeaders(inputHeaders, requestInit.headers, shouldAttachRuntimeAuth(resolvedInput));
      const resolvedUrl =
        resolvedInput instanceof Request ? resolvedInput.url
        : resolvedInput instanceof URL ? resolvedInput.toString()
        : String(resolvedInput);
      addRuntimeProxyHeaders(resolvedUrl, headers);
      doFetch = resolvedInput instanceof Request
        ? () => fetch(new Request(resolvedInput, { ...requestInit, headers }))
        : () => fetch(resolvedInput, { ...requestInit, headers });
      url = resolvedUrl;
      method = String(
        requestInit.method ?? (resolvedInput instanceof Request ? resolvedInput.method : 'GET'),
      ).toUpperCase();
    }

    // Session-expiry classification rides on responses that already flow
    // through here; only the status is read, never the body.
    const rawFetch = doFetch;
    doFetch = () => rawFetch().then((response) => {
      observeRuntimeAuthResponse(url, response.status);
      return response;
    });

    // Transport-level failure of a request aimed at the active runtime means
    // the instance itself is gone: probe the pool, move the runtime, and run
    // this request once more against the instance that answered.
    const shouldRetryAfter = async (response: Response | null): Promise<boolean> => {
      if (!failoverEligible || !isRuntimeServiceUrl(url)) return false;
      if (response && !isFailoverTriggerStatus(response.status)) return false;
      // The local backend booting (503 + restarting) heals on its own —
      // switching instances over it would move a perfectly good session.
      if (response && await isTransientRestartResponse(response)) return false;
      return attemptInstanceFailover();
    };

    const execute = async (): Promise<Response> => {
      try {
        const response = await doFetch();
        if (await shouldRetryAfter(response)) {
          try {
            await response.body?.cancel();
          } catch {
            // The failed body is being discarded either way.
          }
          return attemptFetch(failoverRetrySource!, attempt + 1);
        }
        return response;
      } catch (error) {
        const aborted = (requestInit.signal?.aborted === true)
          || (source instanceof Request && source.signal.aborted)
          || (error instanceof Error && error.name === 'AbortError');
        if (aborted || !(error instanceof Error)) throw error;
        if (await shouldRetryAfter(null)) {
          return attemptFetch(failoverRetrySource!, attempt + 1);
        }
        throw error;
      }
    };

    // A Request always carries a (possibly default) signal; treat any Request, or
    // an explicit init.signal, as "has signal" and skip coalescing for safety.
    const hasSignal = requestInit.signal != null || source instanceof Request;

    // Only the first attempt joins the coalescing map: a failover retry runs
    // *inside* the entry its own attempt 0 registered, so looking the key up
    // again would wait on the very promise that is waiting on it.
    const key = attempt === 0 ? coalesceReadKey(method, url, hasSignal) : null;
    if (!key) return execute();

    const existing = READ_COALESCE.get(key);
    if (existing) return existing.then((res) => res.clone());

    const pending = execute();
    READ_COALESCE.set(key, pending);
    pending.then(
      () => READ_COALESCE.delete(key),
      () => READ_COALESCE.delete(key),
    );
    return pending.then((res) => res.clone());
  };

  return attemptFetch(input, 0);
};

let runtimeFetchBridgeInstalled = false;

export const installRuntimeFetchBridge = (): void => {
  if (runtimeFetchBridgeInstalled || typeof window === 'undefined') return;
  runtimeFetchBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const relayResponse = await tryRelayFetch(input, init ?? {});
    if (relayResponse) return relayResponse;
    if (typeof input === 'string') {
      if (!shouldResolveFetchInput(input)) {
        try {
          const url = new URL(input);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(undefined, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(input, { ...init, headers });
          }
        } catch {
          // Non-URL fetch inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(undefined, init?.headers);
      const target = buildRuntimeFetchUrl(input);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof URL) {
      const raw = input.toString();
      if (!shouldResolveFetchInput(raw)) {
        if (isActiveRuntimeServiceUrl(input)) {
          const headers = await mergeHeaders(undefined, init?.headers);
          addRuntimeProxyHeaders(input.toString(), headers);
          return nativeFetch(input, { ...init, headers });
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(undefined, init?.headers);
      const target = buildRuntimeFetchUrl(raw);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof Request) {
      if (!shouldResolveFetchInput(input.url)) {
        try {
          const url = new URL(input.url);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(input.headers, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(new Request(input, { ...init, headers }));
          }
        } catch {
          // Non-URL request inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(input.headers, init?.headers);
      const target = buildRuntimeFetchUrl(input.url);
      addRuntimeProxyHeaders(target, headers);
      const request = target === input.url ? input : new Request(target, input);
      return nativeFetch(new Request(request, { ...init, headers }));
    }

    return nativeFetch(input, init);
  };
};
