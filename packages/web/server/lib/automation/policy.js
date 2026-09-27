import { evaluatePolicyRules } from './schema.js';

/**
 * Auto-approve policy engine.
 *
 * Two independent layers, both consulted before the existing routing safety
 * net runs:
 *
 * 1. Per-session auto-accept (existing `permission-auto-accept` settings).
 * 2. Rule-based automation policy (this module): glob patterns over tool name
 *    and permission content, first match wins, ordered as configured.
 *
 * When this engine returns a verdict, the permission-auto-accept runtime uses
 * it instead of its default "reply once" path — `hold` leaves the request for
 * the user, `accept` auto-approves, `deny` declines. Returning `null` means
 * "no automation opinion", so callers keep their current behavior.
 *
 * The engine also feeds the approval inbox: every `hold` decision can be
 * journaled so the UI can list pending approvals for batch operations.
 */
export const createPolicyEngine = ({
  store = null,
  onDecision = null,
  now = Date.now,
} = {}) => {
  let cachedPolicy = { rules: [], revision: -1 };
  let loadPromise = null;

  const load = async () => {
    if (!store) return cachedPolicy;
    if (cachedPolicy.revision >= 0) return cachedPolicy;
    if (!loadPromise) {
      loadPromise = store.readPolicy()
        .then((policy) => {
          cachedPolicy = policy;
          return policy;
        })
        .finally(() => { loadPromise = null; });
    }
    return loadPromise;
  };

  const reload = async () => {
    if (!store) return cachedPolicy;
    cachedPolicy = { rules: [], revision: -1 };
    return load();
  };

  const save = async (input) => {
    if (!store) throw new Error('policy store is unavailable');
    cachedPolicy = await store.writePolicy(input);
    return cachedPolicy;
  };

  const snapshot = () => ({
    rules: cachedPolicy.rules.map((rule) => ({ ...rule })),
    revision: cachedPolicy.revision,
  });

  /**
   * Evaluate one permission request. Returns `{ action, ruleId, ruleName }`
   * on a match, or `null` when no rule applies (caller falls through to its
   * existing behavior).
   */
  const evaluate = async (permission) => {
    const policy = await load();
    if (!policy.rules.length) return null;
    return evaluatePolicyRules(policy.rules, permission);
  };

  /**
   * Adapter for the permission-auto-accept `evaluatePermission` hook. Maps
   * the automation verdict onto the routing safety-net contract the existing
   * runtime already understands (`hold` short-circuits; anything else
   * proceeds with the automatic reply).
   */
  const evaluateForAutoAccept = async (permission) => {
    const verdict = await evaluate(permission);
    if (!verdict) return null;
    onDecision?.({ ...verdict, permission, at: now() });
    if (verdict.action === 'hold') return { ...verdict, action: 'hold', source: 'automation-policy' };
    if (verdict.action === 'deny') return { ...verdict, action: 'hold', source: 'automation-policy', denied: true };
    // `accept` maps to "do not hold" so the auto-accept runtime proceeds with
    // its normal reply-once call.
    return { ...verdict, action: 'accept', source: 'automation-policy' };
  };

  /**
   * Compose with an optional outer safety net (routing `evaluatePermission`).
   * Order: automation policy first (it is the more specific, user-authored
   * rule set), then the outer net. The first non-null verdict wins.
   */
  const composeWithOuter = (outerEvaluate) => async (permission, directory) => {
    const inner = await evaluateForAutoAccept(permission);
    if (inner) return inner;
    if (outerEvaluate) return outerEvaluate(permission, directory);
    return null;
  };

  return {
    load,
    reload,
    save,
    snapshot,
    evaluate,
    evaluateForAutoAccept,
    composeWithOuter,
  };
};

/**
 * Journal entry for the approval inbox. Permissions held by the policy engine
 * (or left for the user) are recorded here so the UI can offer batch approve /
 * deny without re-scanning OpenCode.
 */
export const createApprovalJournal = ({ limit = 500, now = Date.now } = {}) => {
  const entries = new Map();
  let seq = 0;

  const record = ({ permissionId, sessionId, directory, action, ruleId = null, ruleName = null, title = null }) => {
    if (!permissionId) return null;
    seq += 1;
    const entry = {
      id: `apr_${seq}_${now()}`,
      permissionId,
      sessionId: sessionId ?? null,
      directory: directory ?? null,
      action,
      at: now(),
      seq,
      status: 'pending',
    };
    if (ruleId) entry.ruleId = ruleId;
    if (ruleName) entry.ruleName = ruleName;
    if (title) entry.title = title;
    entries.set(permissionId, entry);
    if (entries.size > limit) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    return entry;
  };

  const resolve = (permissionId, status) => {
    const entry = entries.get(permissionId);
    if (!entry) return null;
    const next = { ...entry, status, resolvedAt: now() };
    entries.set(permissionId, next);
    return next;
  };

  const remove = (permissionId) => entries.delete(permissionId);

  const list = ({ status = 'pending' } = {}) => (
    Array.from(entries.values())
      .filter((entry) => (status === 'all' ? true : entry.status === status))
      .sort((left, right) => (right.at - left.at) || ((right.seq ?? 0) - (left.seq ?? 0)))
  );

  const clear = () => entries.clear();

  return { record, resolve, remove, list, clear };
};
