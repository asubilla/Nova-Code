import { isDesktopShell, invokeDesktop } from '@/lib/desktop';
import {
  desktopHostsGet,
  desktopHostsSet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  type DesktopHost,
  type DesktopHostsConfig,
} from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/**
 * Auto-discovered instance pool.
 *
 * The switcher used to know only what the user typed. Discovery scans the
 * loopback listeners (see `packages/electron/instance-discovery.mjs`), keeps
 * the Nova Code servers it finds, and folds them into the same persisted host
 * list the switcher and failover already read — so a second local server shows
 * up as a normal instance with nothing configured by hand.
 *
 * OpenCode's own `serve` (kind `opencode`) is deliberately never added: the
 * renderer talks Nova Code's `/api` + `/auth` routes, which a standalone
 * OpenCode does not have. Discovery still reports those ports so the answer to
 * "is my official OpenCode the instance?" is visible in the scan output.
 */

export type DiscoveredInstanceKind = 'novacode' | 'opencode';

export type DiscoveredInstanceStatus =
  | 'ok'
  | 'auth'
  | 'incompatible'
  | 'update-recommended'
  | 'wrong-service'
  | 'unreachable';

export type DiscoveredInstance = {
  port: number;
  url: string;
  kind: DiscoveredInstanceKind;
  status: DiscoveredInstanceStatus;
  latencyMs: number;
};

export type InstanceDiscoveryResult = {
  /** The OS port listing ran — an absent port really is closed, so pruning is safe. */
  ok: boolean;
  instances: DiscoveredInstance[];
};

/** The fallback pool the user asked for is bounded; 20 covers any real setup. */
export const MAX_AUTO_INSTANCES = 20;

const DISMISSED_STORAGE_KEY = 'novacode.dismissed-auto-instances';
const KNOWN_STORAGE_KEY = 'novacode.known-auto-instances';

const DISCOVERED_STATUSES: readonly DiscoveredInstanceStatus[] = [
  'ok',
  'auth',
  'incompatible',
  'update-recommended',
  'wrong-service',
  'unreachable',
];

const normalizeStatus = (value: unknown): DiscoveredInstanceStatus => (
  DISCOVERED_STATUSES.includes(value as DiscoveredInstanceStatus)
    ? (value as DiscoveredInstanceStatus)
    : 'unreachable'
);

const readStoredUrls = (key: string): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
};

const writeStoredUrls = (key: string, urls: string[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...new Set(urls)]));
  } catch {
    // Storage failures only cost us bookkeeping, never the merge itself.
  }
};

const hostUrl = (host: DesktopHost): string => normalizeHostUrl(getDesktopHostApiUrl(host)) || '';

const sameUrlSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((url) => rightSet.has(url));
};

/** Ask the main process to scan this machine. `null` = discovery unavailable. */
export const discoverLocalInstances = async (): Promise<InstanceDiscoveryResult | null> => {
  if (!isDesktopShell()) return null;
  const raw = await invokeDesktop<unknown>('desktop_instances_discover').catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.instances)) return null;

  const instances: DiscoveredInstance[] = [];
  for (const entry of record.instances) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const url = typeof candidate.url === 'string' ? normalizeHostUrl(candidate.url) : null;
    const port = typeof candidate.port === 'number' && Number.isInteger(candidate.port) ? candidate.port : null;
    if (!url || !port) continue;
    instances.push({
      port,
      url,
      kind: candidate.kind === 'opencode' ? 'opencode' : 'novacode',
      status: normalizeStatus(candidate.status),
      latencyMs: typeof candidate.latencyMs === 'number' && Number.isFinite(candidate.latencyMs) ? candidate.latencyMs : 0,
    });
  }
  return { ok: record.ok === true, instances };
};

/**
 * Fold the latest scan into the persisted host list. Idempotent: returns the
 * current config untouched when there is nothing new to do, so callers can use
 * the result unconditionally.
 *
 * Three bookkeeping rules keep the list honest:
 *  - an auto instance the user deleted stays deleted (remembered in
 *    `dismissed` via the known-urls diff);
 *  - an auto instance whose server stopped drops out — only when the port
 *    listing itself succeeded, and never the instance currently connected;
 *  - at most `MAX_AUTO_INSTANCES` auto entries, manual entries unbounded.
 */
export const mergeDiscoveredInstances = async (): Promise<DesktopHostsConfig | null> => {
  const discovery = await discoverLocalInstances();
  if (!discovery) return null;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return null;

  const usable = discovery.instances.filter(
    (instance) => instance.kind === 'novacode' && (instance.status === 'ok' || instance.status === 'auth'),
  );
  const discoveredNovaUrls = new Set(
    discovery.instances.filter((instance) => instance.kind === 'novacode').map((instance) => instance.url),
  );

  const dismissed = new Set(readStoredUrls(DISMISSED_STORAGE_KEY));
  const known = readStoredUrls(KNOWN_STORAGE_KEY);
  const activeUrl = normalizeHostUrl(getRuntimeApiBaseUrl()) || '';

  let hosts = config.hosts;
  let hostsChanged = false;

  for (const url of known) {
    if (dismissed.has(url)) continue;
    if (hosts.some((host) => hostUrl(host) === url)) continue;
    dismissed.add(url);
  }
  if (dismissed.size > 0) writeStoredUrls(DISMISSED_STORAGE_KEY, [...dismissed]);

  if (discovery.ok) {
    const pruned = hosts.filter((host) => {
      if (!host.auto) return true;
      const url = hostUrl(host);
      return !url || url === activeUrl || discoveredNovaUrls.has(url);
    });
    if (pruned.length !== hosts.length) {
      hosts = pruned;
      hostsChanged = true;
    }
  }

  const existingUrls = new Set(hosts.map(hostUrl));
  const autoCount = hosts.filter((host) => host.auto === true).length;
  const additions: DesktopHost[] = [];
  for (const instance of usable) {
    if (existingUrls.has(instance.url) || dismissed.has(instance.url)) continue;
    if (autoCount + additions.length >= MAX_AUTO_INSTANCES) break;
    additions.push({
      id: `auto-${instance.port}`,
      label: `Local :${instance.port}`,
      url: instance.url,
      apiUrl: instance.url,
      auto: true,
    });
    existingUrls.add(instance.url);
  }
  if (additions.length > 0) {
    hosts = [...hosts, ...additions];
    hostsChanged = true;
  }

  const autoUrls = hosts.filter((host) => host.auto === true).map(hostUrl).filter(Boolean);
  if (!sameUrlSet(autoUrls, readStoredUrls(KNOWN_STORAGE_KEY))) {
    writeStoredUrls(KNOWN_STORAGE_KEY, autoUrls);
  }

  if (!hostsChanged) return config;

  await desktopHostsSet({
    hosts,
    defaultHostId: config.defaultHostId,
    initialHostChoiceCompleted: config.initialHostChoiceCompleted,
  });
  return { ...config, hosts };
};
