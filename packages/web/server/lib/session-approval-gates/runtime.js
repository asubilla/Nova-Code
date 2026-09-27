import { z } from 'zod';

const SETTINGS_KEY = 'sessionApprovalGates';
const SESSION_CACHE_LIMIT = 10000;

const booleanSessionsSchema = z
  .record(z.string().min(1), z.unknown())
  .transform((entries) => {
    const sessions = {};
    for (const [sessionId, gated] of Object.entries(entries)) {
      const parsed = z.boolean().safeParse(gated);
      if (parsed.success) sessions[sessionId] = parsed.data;
    }
    return sessions;
  })
  .catch({});

const policySchema = z.object({
  sessions: booleanSessionsSchema,
  revision: z.number().int().nonnegative().catch(0),
});

const normalizePolicy = (value) => policySchema.parse(value ?? {});

const sessionIdSchema = z.string().trim().min(1);
const gatedSchema = z.boolean();

const sessionInfoSchema = z.object({
  id: z.string().min(1),
  parentID: z.string().min(1).nullish(),
  directory: z.string().min(1).nullish(),
});

const openCodeSessionResponseSchema = z.object({
  data: sessionInfoSchema.partial().optional(),
  id: z.string().min(1).optional(),
  parentID: z.string().min(1).nullish(),
  directory: z.string().min(1).nullish(),
}).loose();

const eventEnvelopeSchema = z.object({
  payload: z.unknown(),
  directory: z.string().optional(),
}).loose();

const eventPayloadSchema = z.object({
  type: z.string(),
  properties: z.object({
    info: sessionInfoSchema.partial().optional(),
  }).loose().optional(),
}).loose();

/**
 * Session-scoped approval gates. While a session (or its nearest configured
 * ancestor) is gated, `evaluatePermission` returns `hold` ahead of automation
 * and routing so the auto-accept runtime never replies and the request stays
 * on screen. A child spawned before its ancestor's gate was registered may
 * miss that gate on its first action (spawn race) — accepted product behavior.
 */
export function createSessionApprovalGatesRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  requestTimeoutMs = 5000,
}) {
  let policy = normalizePolicy();
  let loaded = false;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  const sessions = new Map();

  const snapshot = () => ({
    sessions: { ...policy.sessions },
    revision: policy.revision,
  });

  const load = async () => {
    if (loaded) return snapshot();
    if (!loadPromise) {
      loadPromise = readSettingsFromDiskMigrated()
        .then((settings) => {
          policy = normalizePolicy(settings?.[SETTINGS_KEY]);
          loaded = true;
          return snapshot();
        })
        .finally(() => { loadPromise = null; });
    }
    return loadPromise;
  };

  const persistUpdate = (update) => {
    writePromise = writePromise.then(async () => {
      const next = update(policy);
      await persistSettings({ [SETTINGS_KEY]: next });
      policy = next;
      loaded = true;
      broadcastGlobalUiEvent?.({
        type: 'novacode:session-approval-gates.updated',
        properties: snapshot(),
      });
      return snapshot();
    });
    return writePromise;
  };

  const setSessionGate = async (sessionId, gated) => {
    const idParse = sessionIdSchema.safeParse(sessionId);
    if (!idParse.success) throw new TypeError('sessionId is required');
    const gatedParse = gatedSchema.safeParse(gated);
    if (!gatedParse.success) throw new TypeError('gated must be a boolean');
    await load();
    return persistUpdate((current) => ({
      ...current,
      sessions: { ...current.sessions, [idParse.data]: gatedParse.data },
      revision: current.revision + 1,
    }));
  };

  const rememberSession = (rawInfo, directoryHint) => {
    const infoParse = sessionInfoSchema.safeParse(rawInfo);
    if (!infoParse.success) return;
    const info = infoParse.data;
    sessions.set(info.id, {
      parentID: info.parentID ?? null,
      directory: info.directory ?? directoryHint,
    });
    if (sessions.size > SESSION_CACHE_LIMIT) {
      sessions.delete(sessions.keys().next().value);
    }
  };

  const request = async (path, { directory } = {}) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    if (directory) url.searchParams.set('directory', directory);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`OpenCode request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => null);
  };

  const getSession = async (sessionId, directory) => {
    const cached = sessions.get(sessionId);
    if (cached) return cached;
    const body = await request(`/session/${encodeURIComponent(sessionId)}`, { directory });
    const parsed = openCodeSessionResponseSchema.safeParse(body);
    if (parsed.success) {
      const info = parsed.data.data ?? parsed.data;
      rememberSession(info, directory);
    }
    return sessions.get(sessionId) ?? null;
  };

  const isSessionGated = async (sessionId, directory) => {
    await load();
    const seen = new Set();
    let current = sessionId;
    let currentDirectory = directory;
    while (current && !seen.has(current)) {
      if (Object.hasOwn(policy.sessions, current)) return policy.sessions[current] === true;
      seen.add(current);
      let info;
      try {
        info = await getSession(current, currentDirectory);
      } catch {
        // Unknown lineage fails closed: the request still waits for the user
        // when auto-accept is off, and auto-accept treats it as ungated.
        return false;
      }
      current = info?.parentID ?? null;
      currentDirectory = info?.directory ?? currentDirectory;
    }
    return false;
  };

  /** Gate wins over automation and routing: hold keeps the request on screen. */
  const evaluatePermission = async (permission, directory) => {
    const sessionID = z.string().min(1).optional().parse(permission?.sessionID);
    if (!sessionID) return null;
    if (!(await isSessionGated(sessionID, directory))) return null;
    return { action: 'hold', kind: 'approval_gate' };
  };

  const processEvent = (event) => {
    const envelope = eventEnvelopeSchema.safeParse(event);
    if (!envelope.success) return;
    const payload = eventPayloadSchema.safeParse(envelope.data.payload).success
      ? eventPayloadSchema.parse(envelope.data.payload)
      : null;
    const directory = envelope.data.directory && envelope.data.directory !== 'global'
      ? envelope.data.directory
      : undefined;
    if (!payload) return;
    if (payload.type === 'session.created' || payload.type === 'session.updated') {
      rememberSession(payload.properties?.info, directory);
    }
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    void load().catch((error) => {
      console.warn('[session-approval-gates] failed to load policy:', error?.message ?? error);
    });
    return () => {
      unsubscribeEvent();
    };
  };

  return {
    snapshot,
    load,
    setSessionGate,
    isSessionGated,
    evaluatePermission,
    start,
  };
}

export function registerSessionApprovalGateRoutes(app, runtime) {
  app.get('/api/session-approval-gates', async (_req, res) => {
    try {
      res.json(await runtime.load());
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to load session approval gates' });
    }
  });

  app.put('/api/session-approval-gates/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.setSessionGate(req.params.sessionId, req.body?.gated));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });
}
