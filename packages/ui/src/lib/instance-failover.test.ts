import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DesktopHost, HostProbeResult } from './desktopHosts';

let desktopEnabled = true;
let relayActive = false;
let activeUrl = '';
let activeKey = '';
let hosts: DesktopHost[] = [];
let localOrigin = 'http://127.0.0.1:57123';
let probeResults: Record<string, HostProbeResult> = {};
let probeGate: Promise<void> | null = null;
const probeCalls: string[] = [];
const switches: Array<{ apiBaseUrl: string; runtimeKey: string }> = [];
const toasts: string[] = [];

mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string) => { toasts.push(message); },
    error: (message: string) => { toasts.push(message); },
    info: (message: string) => { toasts.push(message); },
    warning: (message: string) => { toasts.push(message); },
    loading: (message: string) => { toasts.push(message); },
  },
}));

const desktopShellModule = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktopShellModule,
  isDesktopShell: () => desktopEnabled,
  isElectronShell: () => false,
}));

const desktopHostsModule = await import('./desktopHosts');
mock.module('./desktopHosts', () => ({
  ...desktopHostsModule,
  desktopHostsGet: async () => ({
    hosts,
    defaultHostId: null,
    initialHostChoiceCompleted: true,
    localOrigin,
  }),
  desktopHostProbe: async (url: string) => {
    probeCalls.push(url);
    if (probeGate) await probeGate;
    return probeResults[url] ?? { status: 'unreachable', latencyMs: 0 };
  },
  desktopLocalClientTokenGet: async () => '',
}));

const runtimeSwitchModule = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({
  ...runtimeSwitchModule,
  getRuntimeApiBaseUrl: () => activeUrl,
  getRuntimeKey: () => activeKey,
  switchRuntimeEndpoint: (options: { apiBaseUrl: string; runtimeKey: string }) => {
    switches.push({ apiBaseUrl: options.apiBaseUrl, runtimeKey: options.runtimeKey });
    activeUrl = options.apiBaseUrl;
    activeKey = options.runtimeKey;
  },
}));

const relayTunnelModule = await import('@/lib/relay/runtime-tunnel');
mock.module('@/lib/relay/runtime-tunnel', () => ({
  ...relayTunnelModule,
  getActiveRelayTunnel: () => (relayActive ? ({} as never) : null),
}));

const {
  attemptInstanceFailover,
  canAttemptInstanceFailover,
  isFailoverTriggerStatus,
  isTransientRestartResponse,
  resetInstanceFailoverStateForTests,
} = await import('./instance-failover');

const remote = (id: string, url: string): DesktopHost => ({ id, label: id, url, apiUrl: url });

describe('failover trigger classification', () => {
  test('502, 503 and 504 are the only statuses that trigger failover', () => {
    expect(isFailoverTriggerStatus(502)).toBe(true);
    expect(isFailoverTriggerStatus(503)).toBe(true);
    expect(isFailoverTriggerStatus(504)).toBe(true);
    expect(isFailoverTriggerStatus(500)).toBe(false);
    expect(isFailoverTriggerStatus(401)).toBe(false);
    expect(isFailoverTriggerStatus(404)).toBe(false);
    expect(isFailoverTriggerStatus(200)).toBe(false);
  });

  test('the readiness gate 503 is transient and leaves the body readable', async () => {
    const response = new Response(JSON.stringify({ restarting: true }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

    expect(await isTransientRestartResponse(response)).toBe(true);
    // The peek must not consume the caller's body.
    expect(await response.json()).toEqual({ restarting: true });
  });

  test('a plain 503 without the restart flag is not transient', async () => {
    expect(await isTransientRestartResponse(new Response('bad gateway', { status: 503 }))).toBe(false);
  });

  test('non-503 statuses are never treated as restarts', async () => {
    const response = new Response(JSON.stringify({ restarting: true }), { status: 502 });
    expect(await isTransientRestartResponse(response)).toBe(false);
  });
});

describe('attemptInstanceFailover', () => {
  beforeEach(() => {
    desktopEnabled = true;
    relayActive = false;
    activeUrl = 'https://active.example';
    activeKey = 'host:active';
    hosts = [];
    localOrigin = 'http://127.0.0.1:57123';
    probeResults = {};
    probeGate = null;
    probeCalls.length = 0;
    switches.length = 0;
    toasts.length = 0;
    resetInstanceFailoverStateForTests();
  });

  test('switches to the first pool member that probes ok', async () => {
    hosts = [
      remote('sick', 'https://sick.example'),
      remote('backup', 'https://backup.example'),
    ];
    probeResults['https://sick.example'] = { status: 'auth', latencyMs: 4 };
    probeResults['https://backup.example'] = { status: 'ok', latencyMs: 12 };

    expect(await attemptInstanceFailover()).toBe(true);

    expect(switches).toEqual([{ apiBaseUrl: 'https://backup.example', runtimeKey: 'host:backup' }]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe('Instance unreachable — switched to "backup"');
    // Local is always offered first, even though it does not answer here.
    expect(probeCalls[0]).toBe('http://127.0.0.1:57123');
  });

  test('prefers Local when it answers', async () => {
    hosts = [remote('remote', 'https://remote.example')];
    probeResults['http://127.0.0.1:57123'] = { status: 'ok', latencyMs: 1 };
    probeResults['https://remote.example'] = { status: 'ok', latencyMs: 50 };

    expect(await attemptInstanceFailover()).toBe(true);

    expect(switches[0]).toEqual({ apiBaseUrl: 'http://127.0.0.1:57123', runtimeKey: 'local' });
    expect(probeCalls).toHaveLength(1);
  });

  test('never switches to the instance already in use', async () => {
    activeUrl = 'https://backup.example';
    activeKey = 'host:backup';
    hosts = [remote('backup', 'https://backup.example')];
    probeResults['https://backup.example'] = { status: 'ok', latencyMs: 1 };

    expect(await attemptInstanceFailover()).toBe(false);
    expect(switches).toHaveLength(0);
    // Local was probed; the active instance was skipped without a probe.
    expect(probeCalls).toEqual(['http://127.0.0.1:57123']);
  });

  test('gives up when no candidate is healthy', async () => {
    hosts = [remote('other', 'https://other.example')];

    expect(await attemptInstanceFailover()).toBe(false);
    expect(switches).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  test('refuses a second attempt inside the cooldown window', async () => {
    hosts = [remote('backup', 'https://backup.example')];
    probeResults['https://backup.example'] = { status: 'ok', latencyMs: 2 };
    expect(await attemptInstanceFailover()).toBe(true);

    // Move somewhere with a healthy candidate again, so only the cooldown can
    // be the reason the next attempt is refused.
    activeUrl = 'https://somewhere-else.example';
    activeKey = 'host:somewhere-else';
    probeCalls.length = 0;

    expect(await attemptInstanceFailover()).toBe(false);
    expect(probeCalls).toHaveLength(0);
  });

  test('concurrent callers share one probe run', async () => {
    hosts = [remote('backup', 'https://backup.example')];
    probeResults['https://backup.example'] = { status: 'ok', latencyMs: 2 };
    let release!: () => void;
    probeGate = new Promise<void>((resolve) => { release = resolve; });

    const first = attemptInstanceFailover();
    const second = attemptInstanceFailover();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(probeCalls).toEqual(['http://127.0.0.1:57123', 'https://backup.example']);
  });

  test('does not run outside a desktop shell', async () => {
    desktopEnabled = false;

    expect(await attemptInstanceFailover()).toBe(false);
    expect(probeCalls).toHaveLength(0);
    expect(canAttemptInstanceFailover()).toBe(false);
  });

  test('does not run on a relay transport', async () => {
    relayActive = true;

    expect(await attemptInstanceFailover()).toBe(false);
    expect(canAttemptInstanceFailover()).toBe(false);
    expect(probeCalls).toHaveLength(0);
  });

  test('a plain desktop shell on a network transport is eligible', () => {
    expect(canAttemptInstanceFailover()).toBe(true);
  });
});
