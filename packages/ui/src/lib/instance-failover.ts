import { toast } from '@/components/ui';
import { isDesktopShell, isElectronShell } from '@/lib/desktop';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopLocalClientTokenGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
} from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  buildLocalDesktopHost,
  runtimeKeyForDesktopHost,
} from '@/lib/desktopCurrentHost';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

/**
 * Automatic instance failover.
 *
 * When a runtime request dies at the transport level (connection refused,
 * timeout) or comes back 502/503/504, the active instance is unusable *right
 * now*. Rather than surfacing "Unable to reach server", probe the configured
 * pool — Local first, then every saved/auto-discovered host — and move the
 * whole runtime to the first instance that answers `ok`. The caller then
 * retries its request once against the new endpoint.
 *
 * Guard rails:
 *  - single-flight, with a minimum interval between attempts, so a burst of
 *    failing requests produces one probe run, not one per request;
 *  - only hosts that probe `ok` are eligible (`auth` would land the user on a
 *    password screen mid-request; unreachable/wrong-service are useless);
 *  - a503 from Nova Code's own readiness gate (`{restarting: true}`) is the
 *    local backend booting — it self-heals in seconds and must not throw the
 *    user onto another instance;
 *  - relay runtimes are out of scope: their transport is the E2EE tunnel, not
 *    an address that can be swapped.
 */

export const FAILOVER_TRIGGER_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const FAILOVER_MIN_INTERVAL_MS = 3_000;

let inflightFailover: Promise<boolean> | null = null;
let lastFailoverAt = 0;

export const isFailoverTriggerStatus = (status: number): boolean => FAILOVER_TRIGGER_STATUSES.has(status);

/**
 * Whether failover is even possible here: a desktop shell on a network
 * transport. The attempt itself is additionally rate-limited — see
 * `attemptInstanceFailover` — so callers can prepare a retry unconditionally.
 */
export const canAttemptInstanceFailover = (): boolean => (
  isDesktopShell() && !isRelayActive()
);

const isRelayActive = (): boolean => Boolean(getActiveRelayTunnel());

const isFailoverCooldownActive = (): boolean => (Date.now() - lastFailoverAt) < FAILOVER_MIN_INTERVAL_MS;

/**
 * The readiness gate answers503 `{ restarting: true }` while its own OpenCode
 * process is coming up. Peeking needs a clone so the caller's response stays
 * readable when we decide to do nothing.
 */
export const isTransientRestartResponse = async (response: Response): Promise<boolean> => {
  if (response.status !== 503) return false;
  try {
    const payload = await response.clone().json() as { restarting?: unknown } | null;
    return payload?.restarting === true;
  } catch {
    return false;
  }
};

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]): string => (
  formatMessage(useI18nStore.getState().dictionary, key, params)
);

const runInstanceFailover = async (): Promise<boolean> => {
  lastFailoverAt = Date.now();

  const currentBase = getRuntimeApiBaseUrl();
  const currentKey = getRuntimeKey();
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return false;

  const localClientToken = isElectronShell()
    ? await desktopLocalClientTokenGet().catch(() => '')
    : '';
  const candidates = [buildLocalDesktopHost(config.localOrigin), ...config.hosts];

  for (const host of candidates) {
    const url = normalizeHostUrl(getDesktopHostApiUrl(host));
    if (!url) continue;
    if (runtimeKeyForDesktopHost(host) === currentKey) continue;
    if (sameOrigin(url, currentBase)) continue;

    const clientToken = host.id === LOCAL_HOST_ID ? localClientToken : (host.clientToken || '');
    const probe = await desktopHostProbe(url, {
      clientToken: clientToken || null,
      requestHeaders: host.requestHeaders || null,
    }).catch(() => null);
    if (probe?.status !== 'ok') continue;

    switchRuntimeEndpoint({
      apiBaseUrl: url,
      clientToken: clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey: runtimeKeyForDesktopHost(host),
    });
    toast.success(t('desktopHostSwitcher.toast.instanceFailover', { host: host.label }));
    return true;
  }

  return false;
};

/**
 * Probe the pool and switch the runtime to the first healthy instance.
 * Resolves `true` when the endpoint changed — the caller should retry its
 * request. Concurrent callers share one run; attempts inside the cooldown
 * window resolve `false` immediately.
 */
export const attemptInstanceFailover = async (): Promise<boolean> => {
  if (!isDesktopShell() || isRelayActive()) return false;
  if (inflightFailover) return inflightFailover;
  if (isFailoverCooldownActive()) return false;

  const run = runInstanceFailover().catch(() => false);
  inflightFailover = run;
  try {
    return await run;
  } finally {
    inflightFailover = null;
  }
};

/** Test seam: forget the cooldown/single-flight state between cases. */
export const resetInstanceFailoverStateForTests = (): void => {
  inflightFailover = null;
  lastFailoverAt = 0;
};
