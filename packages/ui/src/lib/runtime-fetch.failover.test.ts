import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

let failoverResult = false;
let failoverAttempts = 0;
let relayActive = false;

// The failover layer is the unit under test's collaborator: stand in for it so
// these cases observe *when* runtimeFetch consults it, not what a probe run does.
mock.module('./instance-failover', () => ({
  attemptInstanceFailover: async () => {
    failoverAttempts += 1;
    return failoverResult;
  },
  canAttemptInstanceFailover: () => !relayActive,
  isFailoverTriggerStatus: (status: number) => status === 502 || status === 503 || status === 504,
  isTransientRestartResponse: async (response: Response): Promise<boolean> => {
    if (response.status !== 503) return false;
    try {
      const payload = await response.clone().json() as { restarting?: unknown } | null;
      return payload?.restarting === true;
    } catch {
      return false;
    }
  },
}));

const relayTunnelModule = await import('./relay/runtime-tunnel');
mock.module('./relay/runtime-tunnel', () => ({
  ...relayTunnelModule,
  getActiveRelayTunnel: () => (relayActive
    ? { fetch: async () => new Response('bad gateway', { status: 502 }) }
    : null),
}));

const { runtimeFetch } = await import('./runtime-fetch');

const originalFetch = globalThis.fetch;

const withRuntime = async (
  apiBaseUrl: string,
  run: () => Promise<void>,
): Promise<void> => {
  const previous = getRuntimeUrlResolver();
  try {
    configureRuntimeUrlResolver({ apiBaseUrl });
    await run();
  } finally {
    setRuntimeUrlResolver(previous);
    globalThis.fetch = originalFetch;
  }
};

const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('runtimeFetch instance failover', () => {
  beforeEach(() => {
    failoverResult = false;
    failoverAttempts = 0;
    relayActive = false;
  });

  test('retries a trigger-status request exactly once after a successful failover', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = true;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return calls === 1
          ? new Response('bad gateway', { status: 502 })
          : jsonResponse({ ok: true });
      }) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(calls).toBe(2);
      expect(failoverAttempts).toBe(1);
    });
  });

  test('surfaces the failure when no instance took over', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = false;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('bad gateway', { status: 503 });
      }) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(503);
      expect(calls).toBe(1);
      expect(failoverAttempts).toBe(1);
    });
  });

  test('does not consult failover for statuses outside the trigger set', async () => {
    await withRuntime('https://runtime.example', async () => {
      globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(401);
      expect(failoverAttempts).toBe(0);
    });
  });

  test('the readiness gate 503 restart body is returned as-is, without failover', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = true;
      globalThis.fetch = (async () => jsonResponse({ restarting: true }, 503)) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(503);
      // The caller still reads the gate body (it decides when to re-poll).
      expect(await response.json()).toEqual({ restarting: true });
      expect(failoverAttempts).toBe(0);
    });
  });

  test('retries after a transport-level connection failure', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = true;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return jsonResponse({ ok: true });
      }) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(failoverAttempts).toBe(1);
    });
  });

  test('abort errors never fail over', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = true;
      globalThis.fetch = (async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }) as typeof fetch;

      await expect(runtimeFetch('/api/config/providers')).rejects.toThrow('aborted');
      expect(failoverAttempts).toBe(0);
    });
  });

  test('gives the request one retry only — a second failure is surfaced', async () => {
    await withRuntime('https://runtime.example', async () => {
      failoverResult = true;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('still bad', { status: 502 });
      }) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(502);
      expect(calls).toBe(2);
      expect(failoverAttempts).toBe(1);
    });
  });

  test('relay transports never fail over', async () => {
    await withRuntime('https://runtime.example', async () => {
      relayActive = true;
      globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;

      const response = await runtimeFetch('/api/config/providers');

      expect(response.status).toBe(502);
      expect(failoverAttempts).toBe(0);
    });
  });
});
