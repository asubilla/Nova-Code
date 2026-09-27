const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';
const isBooleanValue = (value) => value === true || value === false;

const asNonEmptyString = (value) => {
  if (!isStringValue(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const clampLength = (value, maxLength) => {
  if (!isStringValue(value)) return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const asFiniteNumber = (value, min) => {
  if (!Number.isFinite(value) || value < min) return undefined;
  return value;
};

const clampTo = (value, min, cap) => {
  const parsed = asFiniteNumber(value, min);
  return parsed !== undefined ? Math.min(Math.floor(parsed), cap) : undefined;
};

const asEnabled = (value, fallback) => (isBooleanValue(value) ? value : fallback);

export const AUTOMATION_NAME_MAX_LENGTH = 80;
export const AUTOMATION_PROMPT_MAX_LENGTH = 20_000;
export const AUTOMATION_SECRET_MIN_LENGTH = 16;
export const AUTOMATION_SECRET_MAX_LENGTH = 256;
export const AUTOMATION_LAST_ERROR_MAX_LENGTH = 2_000;
export const AUTOMATION_AUDIT_ENTRY_MAX_LENGTH = 4_000;
export const AUTOMATION_WORKFLOW_MAX_STEPS = 20;
export const AUTOMATION_POLICY_RULES_MAX = 100;
export const AUTOMATION_TRIGGER_KINDS = Object.freeze(['webhook', 'event']);
export const AUTOMATION_EVENT_KINDS = Object.freeze(['session.finished', 'session.failed', 'scheduled.task.failed']);
export const AUTOMATION_POLICY_ACTIONS = Object.freeze(['accept', 'deny', 'hold']);
export const AUTOMATION_WORKFLOW_STEP_KINDS = Object.freeze(['prompt', 'shell']);
export const AUTOMATION_ON_FAIL_ACTIONS = Object.freeze(['stop', 'continue', 'retry']);

const normalizeStatus = (value) => {
  if (value === 'running' || value === 'success' || value === 'error' || value === 'idle') return value;
  return 'idle';
};

const normalizeTimestamp = (value) => {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
};

const normalizeErrorMessage = (value) => {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  return clampLength(raw, AUTOMATION_LAST_ERROR_MAX_LENGTH);
};

const normalizeState = (value, fallback) => {
  const source = isObjectRecord(value) ? value : (isObjectRecord(fallback) ? fallback : {});
  const lastRunAt = normalizeTimestamp(source.lastRunAt);
  const nextRunAt = normalizeTimestamp(source.nextRunAt);
  const lastSessionId = asNonEmptyString(source.lastSessionId);
  const lastError = normalizeErrorMessage(source.lastError);
  const attemptValue = asFiniteNumber(source.attempt, 0);
  const budgetUsedValue = asFiniteNumber(source.budgetUsed, 0);
  const attempt = attemptValue !== undefined ? Math.floor(attemptValue) : 0;
  const budgetUsed = budgetUsedValue !== undefined ? Math.floor(budgetUsedValue) : 0;
  const state = {
    createdAt: normalizeTimestamp(source.createdAt) ?? Date.now(),
    updatedAt: normalizeTimestamp(source.updatedAt) ?? Date.now(),
    lastStatus: normalizeStatus(source.lastStatus),
    attempt,
    budgetUsed,
  };
  if (lastRunAt !== undefined) state.lastRunAt = lastRunAt;
  if (nextRunAt !== undefined) state.nextRunAt = nextRunAt;
  if (lastSessionId) state.lastSessionId = lastSessionId;
  if (lastError) state.lastError = lastError;
  return state;
};

const normalizeSecret = (value, existing) => {
  const incoming = asNonEmptyString(value);
  if (incoming) {
    if (incoming.length < AUTOMATION_SECRET_MIN_LENGTH || incoming.length > AUTOMATION_SECRET_MAX_LENGTH) {
      throw new Error(`secret must be from ${AUTOMATION_SECRET_MIN_LENGTH} to ${AUTOMATION_SECRET_MAX_LENGTH} characters`);
    }
    return incoming;
  }
  const previous = asNonEmptyString(existing);
  return previous || null;
};

const normalizeEventKind = (value) => {
  const kind = asNonEmptyString(value);
  return kind && AUTOMATION_EVENT_KINDS.includes(kind) ? kind : null;
};

/**
 * Normalize one automation trigger definition.
 * Throws on invalid required fields; optional fields are dropped when empty.
 */
export const normalizeTrigger = (value, options = {}) => {
  const { now = Date.now(), existing = null, allowCreate = true } = options;
  if (!isObjectRecord(value)) throw new Error('trigger is required');

  const existingId = asNonEmptyString(existing?.id);
  const incomingId = asNonEmptyString(value.id);
  if (existingId && incomingId && incomingId !== existingId) throw new Error('trigger.id is immutable');
  if (!existingId && incomingId && !allowCreate) throw new Error('trigger.id does not exist');
  const id = existingId || incomingId || `trg_${now}_${Math.random().toString(36).slice(2, 10)}`;

  const name = clampLength(asNonEmptyString(value.name) || '', AUTOMATION_NAME_MAX_LENGTH);
  if (!name) throw new Error('trigger.name is required');

  const kind = asNonEmptyString(value.kind);
  if (!kind || !AUTOMATION_TRIGGER_KINDS.includes(kind)) {
    throw new Error(`trigger.kind must be one of: ${AUTOMATION_TRIGGER_KINDS.join(', ')}`);
  }

  const enabled = asEnabled(value.enabled, existing?.enabled ?? true);

  const targetTaskId = asNonEmptyString(value.targetTaskId);
  const targetWorkflowId = asNonEmptyString(value.targetWorkflowId);
  if (!targetTaskId && !targetWorkflowId) {
    throw new Error('trigger requires targetTaskId or targetWorkflowId');
  }

  const trigger = {
    id,
    name,
    kind,
    enabled,
    state: normalizeState(value.state, existing?.state),
  };
  if (targetTaskId) trigger.targetTaskId = targetTaskId;
  if (targetWorkflowId) trigger.targetWorkflowId = targetWorkflowId;

  if (kind === 'webhook') {
    const secret = normalizeSecret(value.secret, existing?.secret);
    if (!secret) throw new Error('webhook trigger requires a secret');
    trigger.secret = secret;
  }

  if (kind === 'event') {
    const eventKind = normalizeEventKind(value.eventKind);
    if (!eventKind) throw new Error(`trigger.eventKind must be one of: ${AUTOMATION_EVENT_KINDS.join(', ')}`);
    trigger.eventKind = eventKind;
  }

  return trigger;
};

const normalizeBudget = (value, existing) => {
  const source = isObjectRecord(value) ? value : (isObjectRecord(existing) ? existing : null);
  if (!source) return null;
  const maxTokensRaw = asFiniteNumber(source.maxTokens, 1);
  const maxAttemptsRaw = clampTo(source.maxAttempts, 1, 20);
  const maxTokens = maxTokensRaw !== undefined ? Math.floor(maxTokensRaw) : undefined;
  const maxAttempts = maxAttemptsRaw;
  if (maxTokens === undefined && maxAttempts === undefined) return null;
  const budget = {};
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;
  if (maxAttempts !== undefined) budget.maxAttempts = maxAttempts;
  return budget;
};

const normalizeRetry = (value, existing) => {
  const source = isObjectRecord(value) ? value : (isObjectRecord(existing) ? existing : null);
  if (!source) return null;
  const maxRetries = clampTo(source.maxRetries, 0, 10);
  const backoffMs = clampTo(source.backoffMs, 0, 24 * 60 * 60 * 1000);
  if (maxRetries === undefined && backoffMs === undefined) return null;
  const retry = {};
  if (maxRetries !== undefined) retry.maxRetries = maxRetries;
  if (backoffMs !== undefined) retry.backoffMs = backoffMs;
  return retry;
};

const normalizeStep = (value, index) => {
  if (!isObjectRecord(value)) throw new Error(`workflow step ${index} is required`);
  const id = asNonEmptyString(value.id) || `step_${index + 1}`;
  const name = clampLength(asNonEmptyString(value.name) || '', AUTOMATION_NAME_MAX_LENGTH);
  if (!name) throw new Error(`workflow step ${index + 1} name is required`);

  const kind = asNonEmptyString(value.kind) || 'prompt';
  if (!AUTOMATION_WORKFLOW_STEP_KINDS.includes(kind)) {
    throw new Error(`workflow step ${index + 1} kind must be one of: ${AUTOMATION_WORKFLOW_STEP_KINDS.join(', ')}`);
  }

  const onFail = asNonEmptyString(value.onFail) || 'stop';
  if (!AUTOMATION_ON_FAIL_ACTIONS.includes(onFail)) {
    throw new Error(`workflow step ${index + 1} onFail must be one of: ${AUTOMATION_ON_FAIL_ACTIONS.join(', ')}`);
  }

  const step = { id, name, kind, onFail };

  if (kind === 'prompt') {
    const prompt = clampLength(asNonEmptyString(value.prompt) || '', AUTOMATION_PROMPT_MAX_LENGTH);
    if (!prompt) throw new Error(`workflow step ${index + 1} prompt is required`);
    step.prompt = prompt;
    const providerID = asNonEmptyString(value.providerID);
    const modelID = asNonEmptyString(value.modelID);
    if (!providerID || !modelID) throw new Error(`workflow step ${index + 1} requires providerID and modelID`);
    step.providerID = providerID;
    step.modelID = modelID;
    const agent = asNonEmptyString(value.agent);
    if (agent) step.agent = agent;
    const waitForIdle = value.waitForIdle === true;
    step.waitForIdle = waitForIdle;
    if (waitForIdle) {
      step.timeoutMs = clampTo(value.timeoutMs, 1000, 60 * 60 * 1000) ?? 300_000;
    }
  } else {
    const command = clampLength(asNonEmptyString(value.command) || '', 4_000);
    if (!command) throw new Error(`workflow step ${index + 1} command is required`);
    step.command = command;
  }

  return step;
};

/**
 * Normalize one multi-step workflow definition.
 * Steps run in array order; each step has its own onFail policy.
 */
export const normalizeWorkflow = (value, options = {}) => {
  const { now = Date.now(), existing = null, allowCreate = true } = options;
  if (!isObjectRecord(value)) throw new Error('workflow is required');

  const existingId = asNonEmptyString(existing?.id);
  const incomingId = asNonEmptyString(value.id);
  if (existingId && incomingId && incomingId !== existingId) throw new Error('workflow.id is immutable');
  if (!existingId && incomingId && !allowCreate) throw new Error('workflow.id does not exist');
  const id = existingId || incomingId || `wf_${now}_${Math.random().toString(36).slice(2, 10)}`;

  const name = clampLength(asNonEmptyString(value.name) || '', AUTOMATION_NAME_MAX_LENGTH);
  if (!name) throw new Error('workflow.name is required');

  const enabled = asEnabled(value.enabled, existing?.enabled ?? true);

  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('workflow.steps must be a non-empty array');
  }
  if (value.steps.length > AUTOMATION_WORKFLOW_MAX_STEPS) {
    throw new Error(`workflow.steps supports at most ${AUTOMATION_WORKFLOW_MAX_STEPS} steps`);
  }
  const steps = value.steps.map((step, index) => normalizeStep(step, index));
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) throw new Error('workflow step ids must be unique');

  const budget = normalizeBudget(value.budget, existing?.budget);
  const retry = normalizeRetry(value.retry, existing?.retry);

  const workflow = {
    id,
    name,
    enabled,
    steps,
    state: normalizeState(value.state, existing?.state),
  };
  if (budget) workflow.budget = budget;
  if (retry) workflow.retry = retry;
  return workflow;
};

/**
 * One auto-approve policy rule. Patterns are simple glob-like matches against
 * the permission's tool name and command/path metadata.
 */
export const normalizePolicyRule = (value, options = {}) => {
  const { existing = null } = options;
  if (!isObjectRecord(value)) throw new Error('policy rule is required');

  const existingId = asNonEmptyString(existing?.id);
  const incomingId = asNonEmptyString(value.id);
  if (existingId && incomingId && incomingId !== existingId) throw new Error('policy rule id is immutable');
  const id = existingId || incomingId || `rule_${Math.random().toString(36).slice(2, 10)}`;

  const name = clampLength(asNonEmptyString(value.name) || '', AUTOMATION_NAME_MAX_LENGTH);
  if (!name) throw new Error('policy rule name is required');

  const action = asNonEmptyString(value.action);
  if (!action || !AUTOMATION_POLICY_ACTIONS.includes(action)) {
    throw new Error(`policy rule action must be one of: ${AUTOMATION_POLICY_ACTIONS.join(', ')}`);
  }

  const toolPattern = asNonEmptyString(value.toolPattern);
  const contentPattern = asNonEmptyString(value.contentPattern);
  if (!toolPattern && !contentPattern) {
    throw new Error('policy rule requires toolPattern or contentPattern');
  }

  const enabled = asEnabled(value.enabled, existing?.enabled ?? true);

  const rule = { id, name, action, enabled };
  if (toolPattern) rule.toolPattern = toolPattern;
  if (contentPattern) rule.contentPattern = contentPattern;
  return rule;
};

export const normalizePolicyDocument = (value) => {
  const source = isObjectRecord(value) ? value : {};
  const rawRules = Array.isArray(source.rules) ? source.rules : [];
  const rules = [];
  const seen = new Set();
  for (const entry of rawRules) {
    if (rules.length >= AUTOMATION_POLICY_RULES_MAX) break;
    try {
      const rule = normalizePolicyRule(entry);
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      rules.push(rule);
    } catch {
      // Malformed rules are skipped; one bad rule never blocks the rest.
    }
  }
  const revision = Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
  return { rules, revision };
};

const globToRegExp = (pattern) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
};

const safeMatch = (pattern, subject) => {
  if (!pattern || !isStringValue(subject)) return false;
  try {
    return globToRegExp(pattern).test(subject);
  } catch {
    return false;
  }
};

/**
 * Decide a policy action for one permission request against an ordered rule
 * list. First matching enabled rule wins; no match returns null so the caller
 * keeps its existing behavior.
 */
export const evaluatePolicyRules = (rules, permission) => {
  if (!Array.isArray(rules) || rules.length === 0 || !isObjectRecord(permission)) return null;
  const tool = asNonEmptyString(permission.permission) || asNonEmptyString(permission.tool) || '';
  const content = [
    asNonEmptyString(permission.command),
    asNonEmptyString(permission.path),
    asNonEmptyString(permission.pattern),
    asNonEmptyString(permission.title),
  ].filter(Boolean).join(' ');

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    const toolOk = rule.toolPattern ? safeMatch(rule.toolPattern, tool) : true;
    const contentOk = rule.contentPattern ? safeMatch(rule.contentPattern, content) : true;
    if (toolOk && contentOk) return { action: rule.action, ruleId: rule.id, ruleName: rule.name };
  }
  return null;
};

export const normalizeAuditEntry = (value, options = {}) => {
  const { now = Date.now() } = options;
  if (!isObjectRecord(value)) throw new Error('audit entry is required');
  const kind = asNonEmptyString(value.kind);
  if (!kind) throw new Error('audit entry kind is required');
  const status = asNonEmptyString(value.status);
  if (!status) throw new Error('audit entry status is required');
  const projectId = asNonEmptyString(value.projectId);
  const triggerId = asNonEmptyString(value.triggerId);
  const workflowId = asNonEmptyString(value.workflowId);
  const taskId = asNonEmptyString(value.taskId);
  const sessionId = asNonEmptyString(value.sessionId);
  const stepId = asNonEmptyString(value.stepId);
  const error = normalizeErrorMessage(value.error);
  const detail = isObjectRecord(value.detail) ? value.detail : null;
  const entry = {
    id: asNonEmptyString(value.id) || `aud_${now}_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    status,
    at: normalizeTimestamp(value.at) ?? now,
  };
  if (projectId) entry.projectId = projectId;
  if (triggerId) entry.triggerId = triggerId;
  if (workflowId) entry.workflowId = workflowId;
  if (taskId) entry.taskId = taskId;
  if (sessionId) entry.sessionId = sessionId;
  if (stepId) entry.stepId = stepId;
  if (error) entry.error = error;
  if (detail) entry.detail = detail;
  return entry;
};
