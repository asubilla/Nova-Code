import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Local instance auto-discovery.
 *
 * The instance switcher used to only know about hosts the user typed in. This
 * module scans the machine for loopback-listening HTTP servers and classifies
 * them, so a second Nova Code server (dev server, legacy install, another
 * packaged copy) shows up in the pool automatically and the failover layer has
 * somewhere to move when the active instance dies.
 *
 * Two identities are recognised:
 *  - `novacode` — a Nova Code / OpenChamber server (`/api/version` or
 *    `/health` carrying the Nova Code envelope). Only these are usable as a
 *    runtime for the UI, because the renderer's `/api/*` and `/auth/*` routes
 *    are served by Nova Code, not by OpenCode itself.
 *  - `opencode`  — a standalone official `opencode serve` (every route answers
 *    `401` + `WWW-Authenticate: Basic realm="Secure Area"`). Reported for
 *    visibility so a user wondering "is my official OpenCode the instance?"
 *    gets an answer, but never registered as a switchable host: the UI cannot
 *    run on OpenCode's own API.
 */

export const MAX_DISCOVERED_INSTANCES = 20;
const PROBE_TIMEOUT_MS = 900;
const PROBE_CONCURRENCY = 16;
const MAX_PORTS_TO_PROBE = 160;
const LIST_PORTS_TIMEOUT_MS = 5_000;

// Ports worth asking even when the OS port listing is unavailable: the local
// Nova Code server, the legacy OpenChamber port (the old proxy fallback
// target), and OpenCode's default serve port.
const STATIC_CANDIDATE_PORTS = [57123, 3902, 4096];

const isLoopbackishHost = (host) => (
  /^(?:127\.|0\.0\.0\.0$|localhost$|\*|::1$|\[::1\]$|::$|\[::\]$)/i.test(host)
);

/**
 * Pull the local (listening) ports out of `netstat`/`ss` output. Accepts the
 * Windows (`127.0.0.1:57123` + `LISTENING`), Linux (`ss -ltnH`) and macOS
 * (`127.0.0.1.57199` dot-separated) spellings of the same row.
 */
export const parseListeningPorts = (output) => {
  const ports = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!/\bLISTEN(?:ING)?\b/i.test(line)) continue;
    for (const match of line.matchAll(/(?:^|\s)(\S+):(\d{1,5})(?=\s|$)/g)) {
      if (!isLoopbackishHost(match[1])) continue;
      const port = Number(match[2]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
    // macOS netstat spells the local address `127.0.0.1.57199` / `*.631`.
    for (const match of line.matchAll(/(?:^|\s)(?:\d{1,3}(?:\.\d{1,3}){3}|\*)\.(\d{1,5})(?=\s|$)/g)) {
      const port = Number(match[1]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
};

/**
 * Classify a `/api/version` payload the same way `electron-host-probe` does,
 * so a server reported as an instance here also probes `ok` in the switcher.
 * Returns `null` when the payload is not a Nova Code envelope at all.
 */
export const classifyNovaVersionPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || payload.status !== 'ok') return null;
  const compatibility = payload.compatibility;
  const looksLikeNovaCode = typeof payload.novacodeVersion === 'string'
    || typeof payload.runtime === 'string'
    || (compatibility !== null && typeof compatibility === 'object');
  if (!looksLikeNovaCode) return null;
  if (!compatibility || typeof compatibility !== 'object') return 'incompatible';
  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes('api.runtime-url.v1')) {
    return 'incompatible';
  }
  if (compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1) return 'update-recommended';
  return 'ok';
};

export const isNovaHealthPayload = (payload) => (
  Boolean(payload)
  && typeof payload === 'object'
  && payload.status === 'ok'
  && (typeof payload.novacodeVersion === 'string' || typeof payload.runtime === 'string')
);

// Standalone `opencode serve` guards every route with HTTP Basic and the
// "Secure Area" realm; nothing in this repository emits that header, so the
// pair is a reliable fingerprint for "official OpenCode, not Nova Code".
const isOpencodeBasicChallenge = (response) => {
  if (!response || response.status !== 401) return false;
  const challenge = typeof response.headers?.get === 'function' ? (response.headers.get('www-authenticate') || '') : '';
  return /basic\s+realm="?secure area"?/i.test(challenge);
};

const runCommand = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: LIST_PORTS_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout || '');
};

/**
 * Ports with a listening socket on this machine. `ok` distinguishes "the
 * listing ran, anything absent is genuinely closed" from "the listing tool is
 * missing" — only the former is safe to prune instances against.
 */
export const listLoopbackListeningPorts = async ({ platform = process.platform, exec = runCommand } = {}) => {
  if (platform === 'win32') {
    try {
      return { ok: true, ports: parseListeningPorts(await exec('netstat.exe', ['-ano', '-p', 'tcp'])) };
    } catch {
      return { ok: false, ports: [] };
    }
  }
  try {
    return { ok: true, ports: parseListeningPorts(await exec('ss', ['-ltnH'])) };
  } catch {
    // Older macOS/minimal images ship netstat without ss.
  }
  try {
    return { ok: true, ports: parseListeningPorts(await exec('netstat', ['-ltn'])) };
  } catch {
    return { ok: false, ports: [] };
  }
};

/**
 * Ask one port what it is. Returns `null` for "not our business" (anything
 * else on the machine — editors, browsers, package registries).
 */
export const probeLocalCandidate = async (port, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) => {
  const base = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  const latency = () => Math.max(0, Date.now() - startedAt);

  const get = async (pathname) => {
    try {
      return await fetchImpl(`${base}${pathname}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  };

  const entry = (kind, status) => ({ port, url: base, kind, status, latencyMs: latency() });

  const versionResponse = await get('/api/version');
  if (versionResponse && (versionResponse.status < 300 || versionResponse.status === 401 || versionResponse.status === 403)) {
    if (isOpencodeBasicChallenge(versionResponse)) return entry('opencode', 'auth');
    if (versionResponse.ok) {
      const status = classifyNovaVersionPayload(await versionResponse.json().catch(() => null));
      if (status) return entry('novacode', status);
    }
  }

  // Auth-gated Nova Code servers still expose an unauthenticated `/health`;
  // that is also the identity path for servers predating `/api/version`.
  const healthResponse = await get('/health');
  if (healthResponse) {
    if (isOpencodeBasicChallenge(healthResponse)) return entry('opencode', 'auth');
    if (healthResponse.ok) {
      const payload = await healthResponse.json().catch(() => null);
      if (isNovaHealthPayload(payload)) return entry('novacode', 'ok');
    }
  }

  return null;
};

/**
 * Scan this machine for instances. Static well-known ports are always probed;
 * the OS listing adds everything else. Results are capped at
 * `MAX_DISCOVERED_INSTANCES` — the failover pool the user asked for is a
 * bounded list, and a machine with 200 listeners has nothing useful beyond the
 * first handful of Nova Code servers anyway.
 */
export const discoverLocalInstances = async ({ fetchImpl, listPorts, probe } = {}) => {
  const ports = new Set(STATIC_CANDIDATE_PORTS);
  let listingOk = false;
  try {
    const listing = await (listPorts || listLoopbackListeningPorts)();
    listingOk = listing.ok === true;
    for (const port of listing.ports || []) ports.add(port);
  } catch {
    listingOk = false;
  }

  const candidates = [...ports]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    .slice(0, MAX_PORTS_TO_PROBE);
  const runProbe = probe || ((candidate) => probeLocalCandidate(candidate, { fetchImpl }));

  const instances = [];
  for (let index = 0; index < candidates.length; index += PROBE_CONCURRENCY) {
    const chunk = candidates.slice(index, index + PROBE_CONCURRENCY);
    const found = await Promise.all(chunk.map((candidate) => runProbe(candidate).catch(() => null)));
    for (const result of found) {
      if (result) instances.push(result);
    }
    if (instances.length >= MAX_DISCOVERED_INSTANCES) break;
  }

  return {
    ok: listingOk,
    instances: instances
      .sort((left, right) => left.port - right.port)
      .slice(0, MAX_DISCOVERED_INSTANCES),
  };
};
