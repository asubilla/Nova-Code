import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSessionApprovalGatesRuntime, registerSessionApprovalGateRoutes } from './runtime.js';

const sessionIdSchema = z.string().trim().min(1);
const gatedSchema = z.boolean();

const createRuntime = ({ stored, fetchImpl } = {}) => {
  let settings = stored ?? { sessionApprovalGates: { sessions: {} } };
  let eventHandler;
  const runtime = createSessionApprovalGatesRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => settings,
    persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response('[]')),
  });
  runtime.start();
  return {
    runtime,
    getSettings: () => settings,
    emit: (payload, directory = '/project') => eventHandler({ payload, directory }),
  };
};

describe('session approval gates runtime', () => {
  it('persists explicit session gates across runtime restarts', async () => {
    const first = createRuntime();
    await first.runtime.setSessionGate('root', true);

    const second = createRuntime({ stored: first.getSettings() });
    await expect(second.runtime.load()).resolves.toEqual({
      sessions: { root: true },
      revision: 1,
    });
  });

  it('increments the authoritative gate revision', async () => {
    const { runtime, getSettings } = createRuntime();

    await expect(runtime.setSessionGate('root', true)).resolves.toMatchObject({ revision: 1 });
    await expect(runtime.setSessionGate('child', false)).resolves.toMatchObject({ revision: 2 });
    expect(getSettings().sessionApprovalGates.revision).toBe(2);
  });

  it('rejects invalid gate writes', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.setSessionGate('', true)).rejects.toBeInstanceOf(TypeError);
    await expect(runtime.setSessionGate('root', 'yes')).rejects.toBeInstanceOf(TypeError);
  });

  it('uses nearest explicit ancestor gate for subagents', async () => {
    const { runtime, emit } = createRuntime({
      stored: { sessionApprovalGates: { sessions: { root: true, child: false } } },
    });
    emit({ type: 'session.created', properties: { info: { id: 'child', parentID: 'root' } } });
    emit({ type: 'session.created', properties: { info: { id: 'grandchild', parentID: 'child' } } });
    await expect(runtime.isSessionGated('grandchild', '/project')).resolves.toBe(false);
    await runtime.setSessionGate('child', true);
    await expect(runtime.isSessionGated('grandchild', '/project')).resolves.toBe(true);
  });

  it('holds a gated permission and passes an ungated one', async () => {
    const { runtime } = createRuntime({
      stored: { sessionApprovalGates: { sessions: { root: true } } },
    });
    await expect(runtime.evaluatePermission({ id: 'p1', sessionID: 'root' }, '/project'))
      .resolves.toEqual({ action: 'hold', kind: 'approval_gate' });
    await expect(runtime.evaluatePermission({ id: 'p2', sessionID: 'other' }, '/project'))
      .resolves.toBeNull();
  });

  it('fetches missing subagent lineage before deciding', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/session/child') return Response.json({ id: 'child', parentID: 'root', directory: '/project' });
      return new Response('', { status: 404 });
    });
    const { runtime } = createRuntime({
      stored: { sessionApprovalGates: { sessions: { root: true } } },
      fetchImpl,
    });
    await expect(runtime.isSessionGated('child', '/project')).resolves.toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname === '/session/child')).toBe(true);
  });

  it('broadcasts a gate policy update on write', async () => {
    const broadcastGlobalUiEvent = vi.fn();
    let settings = { sessionApprovalGates: { sessions: {} } };
    const runtime = createSessionApprovalGatesRuntime({
      globalEventHub: { subscribeEvent: () => () => {} },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => settings,
      persistSettings: async (changes) => { settings = { ...settings, ...changes }; },
      broadcastGlobalUiEvent,
    });
    await runtime.setSessionGate('root', true);
    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'novacode:session-approval-gates.updated',
      properties: { sessions: { root: true }, revision: 1 },
    });
  });
});

describe('registerSessionApprovalGateRoutes', () => {
  const collectRoutes = () => {
    const routes = new Map();
    const app = {
      get(path, handler) { routes.set(`GET ${path}`, handler); },
      put(path, handler) { routes.set(`PUT ${path}`, handler); },
    };
    return { app, routes };
  };

  it('registers GET and PUT gate routes', async () => {
    const { app, routes } = collectRoutes();
    registerSessionApprovalGateRoutes(app, {
      load: async () => ({ sessions: { root: true }, revision: 1 }),
      setSessionGate: async (sessionId, gated) => {
        const idParse = sessionIdSchema.safeParse(sessionId);
        if (!idParse.success) throw new TypeError('sessionId is required');
        const gatedParse = gatedSchema.safeParse(gated);
        if (!gatedParse.success) throw new TypeError('gated must be a boolean');
        return { sessions: { [idParse.data]: gatedParse.data }, revision: 2 };
      },
    });
    expect([...routes.keys()]).toEqual([
      'GET /api/session-approval-gates',
      'PUT /api/session-approval-gates/sessions/:sessionId',
    ]);

    const getHandler = routes.get('GET /api/session-approval-gates');
    const getRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getHandler({}, getRes);
    expect(getRes.json).toHaveBeenCalledWith({ sessions: { root: true }, revision: 1 });

    const putHandler = routes.get('PUT /api/session-approval-gates/sessions/:sessionId');
    const putRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await putHandler({ params: { sessionId: 'child' }, body: { gated: true } }, putRes);
    expect(putRes.json).toHaveBeenCalledWith({ sessions: { child: true }, revision: 2 });

    const badRes = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await putHandler({ params: { sessionId: '' }, body: { gated: true } }, badRes);
    expect(badRes.status).toHaveBeenCalledWith(400);
  });
});
