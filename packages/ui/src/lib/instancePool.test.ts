import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DesktopHost } from './desktopHosts';

let desktopEnabled = true;
let discoveryResult: unknown = null;
let activeUrl = '';
let storedHosts: DesktopHost[] = [];
let storedDefaultHostId: string | null = null;
let initialHostChoiceCompleted = true;
const persistCalls: DesktopHost[][] = [];
const storage = new Map<string, string>();

// The pool keeps its bookkeeping (dismissed/known auto URLs) in localStorage;
// bun has no window, so the module gets the smallest one that satisfies it.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: { origin: 'http://127.0.0.1:57123', href: 'http://127.0.0.1:57123/' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  },
});

const desktopShellModule = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktopShellModule,
  isDesktopShell: () => desktopEnabled,
  invokeDesktop: async (command: string) => (command === 'desktop_instances_discover' ? discoveryResult : null),
}));

const desktopHostsModule = await import('./desktopHosts');
mock.module('./desktopHosts', () => ({
  ...desktopHostsModule,
  desktopHostsGet: async () => ({
    hosts: storedHosts,
    defaultHostId: storedDefaultHostId,
    initialHostChoiceCompleted,
    localOrigin: 'http://127.0.0.1:57123',
  }),
  desktopHostsSet: async (config: { hosts: DesktopHost[]; defaultHostId?: string | null }) => {
    persistCalls.push(config.hosts);
    storedHosts = config.hosts;
    if (config.defaultHostId !== undefined) storedDefaultHostId = config.defaultHostId;
  },
}));

const runtimeSwitchModule = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({
  ...runtimeSwitchModule,
  getRuntimeApiBaseUrl: () => activeUrl,
}));

const { MAX_AUTO_INSTANCES, mergeDiscoveredInstances } = await import('./instancePool');

type InstanceInput = {
  port: number;
  url?: string;
  kind?: 'novacode' | 'opencode';
  status?: string;
};

const discovery = (instances: InstanceInput[], ok = true) => ({
  ok,
  instances: instances.map((instance) => ({
    port: instance.port,
    url: instance.url ?? `http://127.0.0.1:${instance.port}`,
    kind: instance.kind ?? 'novacode',
    status: instance.status ?? 'ok',
    latencyMs: 3,
  })),
});

const nova = (port: number, status = 'ok'): InstanceInput => ({ port, status });

describe('mergeDiscoveredInstances', () => {
  beforeEach(() => {
    desktopEnabled = true;
    discoveryResult = null;
    activeUrl = '';
    storedHosts = [];
    storedDefaultHostId = null;
    initialHostChoiceCompleted = true;
    persistCalls.length = 0;
    storage.clear();
  });

  test('adds every healthy local Nova Code server as an auto instance', async () => {
    discoveryResult = discovery([nova(57124), nova(4096, 'auth')]);

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts.map((host) => host.id)).toEqual(['auto-57124', 'auto-4096']);
    expect(config?.hosts[0]).toMatchObject({
      auto: true,
      label: 'Local :57124',
      url: 'http://127.0.0.1:57124',
      apiUrl: 'http://127.0.0.1:57124',
    });
    expect(persistCalls).toHaveLength(1);
  });

  test('ignores standalone OpenCode and unhealthy services', async () => {
    discoveryResult = discovery([
      { port: 45999, kind: 'opencode', status: 'ok' },
      nova(57124, 'wrong-service'),
      nova(57125, 'unreachable'),
      nova(57126, 'incompatible'),
      nova(57127, 'update-recommended'),
    ]);

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts).toEqual([]);
    expect(persistCalls).toHaveLength(0);
  });

  test('a second identical scan does not rewrite the config', async () => {
    discoveryResult = discovery([nova(57124)]);
    await mergeDiscoveredInstances();
    const config = await mergeDiscoveredInstances();

    expect(config?.hosts).toHaveLength(1);
    expect(persistCalls).toHaveLength(1);
  });

  test('an auto instance the user deleted stays deleted', async () => {
    discoveryResult = discovery([nova(57124)]);
    await mergeDiscoveredInstances();

    // The user removes the row from the switcher/settings list.
    storedHosts = [];
    persistCalls.length = 0;

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts).toEqual([]);
    expect(persistCalls).toHaveLength(0);
    const dismissed = JSON.parse(storage.get('novacode.dismissed-auto-instances') ?? '[]') as string[];
    expect(dismissed).toContain('http://127.0.0.1:57124');
  });

  test('prunes auto instances whose server stopped, but never the active one', async () => {
    const stopped = { id: 'auto-6001', label: 'Local :6001', url: 'http://127.0.0.1:6001', apiUrl: 'http://127.0.0.1:6001', auto: true } as DesktopHost;
    const active = { id: 'auto-6002', label: 'Local :6002', url: 'http://127.0.0.1:6002', apiUrl: 'http://127.0.0.1:6002', auto: true } as DesktopHost;
    const manual = { id: 'manual', label: 'Manual', url: 'https://manual.example', apiUrl: 'https://manual.example' } as DesktopHost;
    storedHosts = [stopped, active, manual];
    activeUrl = 'http://127.0.0.1:6002';
    discoveryResult = discovery([], true);

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts.map((host) => host.id)).toEqual(['auto-6002', 'manual']);
    expect(persistCalls).toHaveLength(1);
  });

  test('keeps everything when the port listing itself failed', async () => {
    const auto = { id: 'auto-6001', label: 'Local :6001', url: 'http://127.0.0.1:6001', apiUrl: 'http://127.0.0.1:6001', auto: true } as DesktopHost;
    storedHosts = [auto];
    discoveryResult = discovery([], false);

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts).toHaveLength(1);
    expect(persistCalls).toHaveLength(0);
  });

  test('caps the auto pool at MAX_AUTO_INSTANCES', async () => {
    discoveryResult = discovery(Array.from({ length: MAX_AUTO_INSTANCES + 5 }, (_, index) => nova(6001 + index)));

    const config = await mergeDiscoveredInstances();

    expect(config?.hosts).toHaveLength(MAX_AUTO_INSTANCES);
    expect(config?.hosts.every((host) => host.auto === true)).toBe(true);
  });

  test('returns null when discovery is unavailable', async () => {
    expect(await mergeDiscoveredInstances()).toBeNull();

    desktopEnabled = false;
    discoveryResult = discovery([nova(57124)]);
    expect(await mergeDiscoveredInstances()).toBeNull();
    expect(persistCalls).toHaveLength(0);
  });
});
