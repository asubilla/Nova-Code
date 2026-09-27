import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => new Map() }));

const { useSessionGateStore, sessionGatedByPolicy } = await import('./sessionGateStore');

const session = (id: string, parentID?: string): Session => {
  // SAFETY: minimal session fixture for lineage walks; only id/parentID are read.
  const base = { id } as Session;
  if (parentID) base.parentID = parentID;
  return base;
};

const json = (value: string, status = 200) => new Response(value, { status });
const jsonBody = (value: { sessions?: unknown; revision?: number }, status = 200) =>
  json(JSON.stringify(value), status);

describe('sessionGatedByPolicy', () => {
  test('returns false for an empty gate map', () => {
    expect(sessionGatedByPolicy({
      gates: {},
      sessionById: new Map(),
      sessionID: 's1',
    })).toBe(false);
  });

  test('uses the nearest explicit ancestor gate', () => {
    const sessionById = new Map<string, Session>([
      ['child', session('child', 'root')],
      ['grandchild', session('grandchild', 'child')],
      ['root', session('root')],
    ]);
    expect(sessionGatedByPolicy({
      gates: { root: true, child: false },
      sessionById,
      sessionID: 'grandchild',
    })).toBe(false);
    expect(sessionGatedByPolicy({
      gates: { root: true },
      sessionById,
      sessionID: 'grandchild',
    })).toBe(true);
  });
});

describe('useSessionGateStore', () => {
  beforeEach(() => {
    useSessionGateStore.getState().reset();
    fetchImpl = async () => jsonBody({ sessions: {} });
  });

  test('rejects a lower revision snapshot', () => {
    useSessionGateStore.getState().applySnapshot({ sessions: { a: true }, revision: 5 });
    useSessionGateStore.getState().applySnapshot({ sessions: { a: false }, revision: 4 });
    expect(useSessionGateStore.getState().gates).toEqual({ a: true });
    expect(useSessionGateStore.getState().lastAppliedRevision).toBe(5);
  });

  test('applies an equal or higher revision', () => {
    useSessionGateStore.getState().applySnapshot({ sessions: { a: true }, revision: 1 });
    useSessionGateStore.getState().applySnapshot({ sessions: { a: false }, revision: 2 });
    expect(useSessionGateStore.getState().gates).toEqual({ a: false });
    expect(useSessionGateStore.getState().lastAppliedRevision).toBe(2);
  });

  test('ignores non-boolean session entries', () => {
    useSessionGateStore.getState().applySnapshot({
      sessions: { good: true, bad: 'yes', empty: '' },
    });
    expect(useSessionGateStore.getState().gates).toEqual({ good: true });
  });

  test('hydrate fails closed without clearing prior state', async () => {
    useSessionGateStore.getState().applySnapshot({ sessions: { keep: true }, revision: 3 });
    fetchImpl = async () => json('{}', 503);
    await expect(useSessionGateStore.getState().hydrate()).rejects.toThrow();
    expect(useSessionGateStore.getState().gates).toEqual({ keep: true });
  });

  test('hydrate adopts the authoritative server snapshot', async () => {
    fetchImpl = async () => jsonBody({ sessions: { root: true }, revision: 1 });
    await useSessionGateStore.getState().hydrate();
    expect(useSessionGateStore.getState().gates).toEqual({ root: true });
    expect(useSessionGateStore.getState().lastAppliedRevision).toBe(1);
  });

  test('setSessionGate only updates after server persistence succeeds', async () => {
    fetchImpl = async () => json('{}', 500);
    await expect(useSessionGateStore.getState().setSessionGate('root', true)).rejects.toThrow();
    expect(useSessionGateStore.getState().gates).toEqual({});

    fetchImpl = async () => jsonBody({ sessions: { root: true }, revision: 1 });
    await useSessionGateStore.getState().setSessionGate('root', true);
    expect(useSessionGateStore.getState().gates).toEqual({ root: true });
  });
});
