import { createAutomationStore } from './store.js';
import { createPolicyEngine } from './policy.js';

const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

const asNonEmptyString = (value) => {
  if (!isStringValue(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = isObjectRecord;

/** Strip `secret` from one trigger (list/serialize path; invariant #1). */
const withoutSecret = (trigger) => {
  if (!isObjectRecord(trigger)) return trigger;
  const { secret, ...safe } = trigger;
  void secret;
  return safe;
};

/**
 * Validate and persist automation payloads before they reach the store.
 * Throws descriptive errors with `statusCode: 400` so routes can map them
 * without string-sniffing.
 */
const fail = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

export const createAutomationService = (dependencies = {}) => {
  const {
    store = createAutomationStore(dependencies),
    policyEngine = createPolicyEngine({ store }),
    approvalJournal = null,
    runtime = null,
    // The runtime constructs the service before its own API object exists, so
    // callers may pass a thunk instead of a frozen reference.
    getRuntime = () => runtime,
    now = Date.now,
  } = dependencies;

  const resolveRuntime = () => {
    try {
      return getRuntime ? (getRuntime() ?? runtime) : runtime;
    } catch {
      return runtime;
    }
  };

  const requireProjectId = (projectId) => {
    const id = asNonEmptyString(projectId);
    if (!id) throw fail('projectId is required');
    return id;
  };

  const list = async (projectId) => {
    const id = requireProjectId(projectId);
    const [triggers, workflows] = await Promise.all([
      store.listTriggers(id),
      store.listWorkflows(id),
    ]);
    // Secrets never leave the server.
    return {
      triggers: triggers.map(withoutSecret),
      workflows,
    };
  };

  const upsertTrigger = async (projectId, triggerInput) => {
    const id = requireProjectId(projectId);
    if (!isPlainObject(triggerInput)) throw fail('trigger payload is required');
    try {
      const result = await store.upsertTrigger(id, triggerInput);
      // The store returns the full trigger list with secrets; strip both
      // the upserted trigger and every entry in the list before they leave.
      return {
        ...result,
        trigger: withoutSecret(result.trigger),
        triggers: (Array.isArray(result.triggers) ? result.triggers : []).map(withoutSecret),
      };
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) throw error;
      throw fail(error?.message || 'invalid trigger');
    }
  };

  const removeTrigger = async (projectId, triggerId) => {
    const id = requireProjectId(projectId);
    const triggerID = asNonEmptyString(triggerId);
    if (!triggerID) throw fail('triggerId is required');
    const result = await store.deleteTrigger(id, triggerID);
    return {
      ...result,
      triggers: (Array.isArray(result.triggers) ? result.triggers : []).map(withoutSecret),
    };
  };

  const upsertWorkflow = async (projectId, workflowInput) => {
    const id = requireProjectId(projectId);
    if (!isPlainObject(workflowInput)) throw fail('workflow payload is required');
    try {
      return await store.upsertWorkflow(id, workflowInput);
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) throw error;
      throw fail(error?.message || 'invalid workflow');
    }
  };

  const removeWorkflow = async (projectId, workflowId) => {
    const id = requireProjectId(projectId);
    const workflowID = asNonEmptyString(workflowId);
    if (!workflowID) throw fail('workflowId is required');
    return store.deleteWorkflow(id, workflowID);
  };

  const runWorkflow = async (projectId, workflowId) => {
    const id = requireProjectId(projectId);
    const workflowID = asNonEmptyString(workflowId);
    if (!workflowID) throw fail('workflowId is required');
    const active = resolveRuntime();
    if (!active || !active.runWorkflow) {
      const error = new Error('automation runtime is unavailable');
      error.statusCode = 503;
      throw error;
    }
    return active.runWorkflow(id, workflowID, { reason: 'manual' });
  };

  const fireTrigger = async (projectId, triggerId, options) => {
    const id = requireProjectId(projectId);
    const triggerID = asNonEmptyString(triggerId);
    if (!triggerID) throw fail('triggerId is required');
    const active = resolveRuntime();
    if (!active || !active.fireTrigger) {
      const error = new Error('automation runtime is unavailable');
      error.statusCode = 503;
      throw error;
    }
    // Third argument is the options bag (`{ reason, payload, verified }`),
    // matching the runtime contract; routes pass the HTTP body straight through.
    const opts = isPlainObject(options) ? options : {};
    return active.fireTrigger(id, triggerID, { reason: 'manual', ...opts });
  };

  const getPolicy = async () => policyEngine.load();
  const putPolicy = async (input) => {
    if (!isPlainObject(input)) throw fail('policy payload is required');
    return policyEngine.save(input);
  };

  const listApprovals = async ({ status = 'pending' } = {}) => {
    if (!approvalJournal) return { approvals: [] };
    const normalized = ['pending', 'approved', 'denied', 'all'].includes(status) ? status : 'pending';
    return { approvals: approvalJournal.list({ status: normalized }) };
  };

  const resolveApproval = async (permissionId, decision) => {
    const id = asNonEmptyString(permissionId);
    if (!id) throw fail('permissionId is required');
    const normalized = asNonEmptyString(decision);
    if (normalized !== 'approved' && normalized !== 'denied') throw fail('decision must be approved or denied');
    if (!approvalJournal) throw fail('approval journal is unavailable');
    const entry = approvalJournal.resolve(id, normalized);
    if (!entry) {
      const error = new Error('approval not found');
      error.statusCode = 404;
      throw error;
    }
    const active = resolveRuntime();
    if (active && active.replyApproval) {
      await active.replyApproval(entry, normalized).catch(() => undefined);
    }
    return { approval: entry };
  };

  const listAudit = async (projectId, options = {}) => {
    const id = requireProjectId(projectId);
    return { entries: await store.listAudit(id, options) };
  };

  return {
    store,
    policyEngine,
    approvalJournal,
    now,
    list,
    upsertTrigger,
    removeTrigger,
    upsertWorkflow,
    removeWorkflow,
    runWorkflow,
    fireTrigger,
    getPolicy,
    putPolicy,
    listApprovals,
    resolveApproval,
    listAudit,
  };
};
