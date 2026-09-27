import { createAutomationStore } from './store.js';
import { createPolicyEngine, createApprovalJournal } from './policy.js';
import { createAutomationService } from './service.js';
import { buildAutomationEvent, findMatchingEventTriggers, findMatchingWebhookTriggers, verifyWebhookSecret } from './triggers.js';
import { runWorkflow as executeWorkflow, executeWorkflowStep, runShellStep, runPromptStep, decideStepOutcome } from './workflows.js';
import { buildEscalation, clampErrorMessage, computeRetryDelay, createBudgetTracker, runWithRetries } from './retries.js';
import { normalizeAuditEntry, normalizePolicyDocument, normalizePolicyRule, normalizeTrigger, normalizeWorkflow, evaluatePolicyRules, AUTOMATION_EVENT_KINDS, AUTOMATION_ON_FAIL_ACTIONS, AUTOMATION_POLICY_ACTIONS, AUTOMATION_POLICY_RULES_MAX, AUTOMATION_SECRET_MAX_LENGTH, AUTOMATION_SECRET_MIN_LENGTH, AUTOMATION_TRIGGER_KINDS, AUTOMATION_WORKFLOW_MAX_STEPS, AUTOMATION_WORKFLOW_STEP_KINDS, AUTOMATION_LAST_ERROR_MAX_LENGTH, AUTOMATION_AUDIT_ENTRY_MAX_LENGTH, AUTOMATION_NAME_MAX_LENGTH, AUTOMATION_PROMPT_MAX_LENGTH } from './schema.js';

/**
 * Automation runtime.
 *
 * Orchestrates triggers, workflows, budgets, retries, the approval inbox, and
 * the audit log for one Nova Code server. Project definitions live in the
 * automation store; policy lives beside them. Execution reuses the same
 * OpenCode client helpers the scheduled-task runtime uses so automation and
 * schedules share one dispatch path.
 */
export const createAutomationRuntime = (dependencies = {}) => {
  const {
    store = createAutomationStore(dependencies),
    policyEngine = createPolicyEngine({ store }),
    approvalJournal = createApprovalJournal(dependencies),
    listProjects = null,
    buildOpenCodeUrl = null,
    getOpenCodeAuthHeaders = null,
    waitForOpenCodeReady = null,
    createClient = null,
    fetchImpl = fetch,
    broadcastGlobalUiEvent = null,
    emitEscalation = null,
    logger = console,
    sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); }),
    now = Date.now,
  } = dependencies;

  const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

  const runningWorkflows = new Map();
  const projectPathByID = new Map();
  const projectIdByPath = new Map();

  const ensureProjectPath = async (projectID) => {
    if (projectPathByID.has(projectID)) return projectPathByID.get(projectID) || null;
    if (!listProjects) return null;
    try {
      const projects = await listProjects();
      for (const project of projects) {
        if (project?.id && project?.path) {
          projectPathByID.set(project.id, project.path);
          projectIdByPath.set(project.path, project.id);
        }
      }
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) return project.path;
    } catch {
      // path resolution is best-effort
    }
    return null;
  };

  /**
   * Map a session directory onto its project id so lifecycle events can fan
   * out without the caller knowing the project. Falls back to listing once
   * when the path cache is still cold.
   */
  const resolveProjectIdForDirectory = async (directory) => {
    if (!directory) return null;
    if (projectIdByPath.has(directory)) return projectIdByPath.get(directory);
    if (!listProjects) return null;
    try {
      const projects = await listProjects();
      for (const project of projects) {
        if (project?.id && project?.path) {
          projectPathByID.set(project.id, project.path);
          projectIdByPath.set(project.path, project.id);
        }
      }
      if (projectIdByPath.has(directory)) return projectIdByPath.get(directory);
      // Worktrees sit under the project path; match by prefix as a fallback.
      for (const [path, id] of projectIdByPath) {
        if (path && (directory === path || directory.startsWith(`${path}${path.endsWith(path.sep) ? '' : path.sep}`))) {
          return id;
        }
      }
    } catch {
      // best-effort
    }
    return null;
  };

  const emitEvent = (type, properties) => {
    try {
      broadcastGlobalUiEvent?.({ type, properties });
    } catch {
      // UI broadcast must never fail a run
    }
  };

  const audit = async (projectId, entryInput) => {
    try {
      const entry = normalizeAuditEntry(entryInput, { now: now() });
      await store.appendAudit(projectId, entry);
      emitEvent('novacode:automation.audit', { projectId, entry });
      return entry;
    } catch (error) {
      logger.warn?.('[automation] audit append failed:', error?.message ?? error);
      return null;
    }
  };

  const notifyEscalation = (escalation) => {
    if (!escalation) return;
    try {
      emitEvent(escalation.type, escalation.properties);
      emitEscalation?.(escalation);
    } catch {
      // notification failure is non-fatal
    }
  };

  const baseUrl = () => (buildOpenCodeUrl ? buildOpenCodeUrl('/', '').replace(/\/$/, '') : '');
  const authHeaders = () => (getOpenCodeAuthHeaders ? getOpenCodeAuthHeaders() : {});

  const ready = async () => {
    if (waitForOpenCodeReady) await waitForOpenCodeReady(10_000, 250);
  };

  const getClient = async () => {
    if (!createClient) return null;
    await ready();
    return createClient({ baseUrl: baseUrl(), headers: authHeaders() });
  };

  const createSession = async ({ directory, title }) => {
    const client = await getClient();
    if (!client) throw new Error('opencode client is unavailable');
    const response = await client.session.create({ directory, title });
    const sessionID = response?.data?.id;
    if (!sessionID) throw new Error('failed to create session');
    return sessionID;
  };

  /**
   * Run one workflow to completion (with concurrency guard). Returns the run
   * report; concurrent calls for the same workflow return `{ running: true }`.
   */
  const runWorkflow = async (projectId, workflowId, { reason = 'manual' } = {}) => {
    const key = `${projectId}:${workflowId}`;
    if (runningWorkflows.has(key)) return { ok: false, running: true };
    // Claim the key synchronously so a concurrent call observes it before the
    // first await; otherwise two runs can pass the guard together.
    runningWorkflows.set(key, now());
    let workflow = null;

    try {
      const workflows = await store.listWorkflows(projectId);
      workflow = workflows.find((entry) => entry.id === workflowId);
      if (!workflow) {
        const error = new Error('workflow not found');
        error.statusCode = 404;
        throw error;
      }

      await store.updateWorkflowState(projectId, workflowId, { lastStatus: 'running', lastError: undefined, updatedAt: now() });
      emitEvent('novacode:automation.workflow.started', { projectId, workflowId, reason, at: now() });

      const projectPath = (await ensureProjectPath(projectId)) || process.cwd();
      // Shell-only runs must not require OpenCode. Prompt steps call
      // `createSession` → `getClient` → `ready()` themselves, so the hard
      // gate lives at the point of use instead of failing every workflow
      // when the OpenCode port is unavailable. `baseUrl()`/`authHeaders()`
      // also throw without a live port, so only evaluate them when a prompt
      // step will actually use them.
      const needsOpenCode = Array.isArray(workflow.steps)
        && workflow.steps.some((step) => step?.kind === 'prompt');
      if (needsOpenCode) await ready();

      const report = await executeWorkflow({
        workflow,
        projectPath,
        baseUrl: needsOpenCode ? baseUrl() : '',
        authHeaders: needsOpenCode ? authHeaders() : {},
        fetchImpl,
        createSession,
        sleep,
        context: { projectId },
        onStep: ({ step, result }) => {
          const stepEvent = {
            projectId,
            workflowId,
            stepId: step.id,
            ok: result.ok,
          };
          if (result.error) stepEvent.error = result.error;
          emitEvent('novacode:automation.workflow.step', stepEvent);
        },
      });

      const budgetUsed = report.budget?.used ?? workflow.state?.budgetUsed ?? 0;
      const attempt = report.budget?.attempt ?? workflow.state?.attempt ?? 0;
      const statePatch = {
        lastStatus: report.ok ? 'success' : 'error',
        lastError: report.ok ? undefined : (report.error || report.status),
        lastRunAt: now(),
        budgetUsed,
        attempt,
        updatedAt: now(),
      };
      if (report.sessionId) statePatch.lastSessionId = report.sessionId;
      await store.updateWorkflowState(projectId, workflowId, statePatch);

      const auditEntry = {
        kind: 'workflow',
        status: report.ok ? 'success' : 'error',
        projectId,
        workflowId,
        detail: { reason, durationMs: report.durationMs, steps: report.stepResults?.length ?? 0, status: report.status },
      };
      if (report.sessionId) auditEntry.sessionId = report.sessionId;
      if (report.error) auditEntry.error = report.error;
      await audit(projectId, auditEntry);

      if (report.escalated) notifyEscalation(report.escalated);
      const finishedEvent = {
        projectId,
        workflowId,
        ok: report.ok,
        status: report.status,
      };
      if (report.error) finishedEvent.error = report.error;
      emitEvent('novacode:automation.workflow.finished', finishedEvent);

      return report;
    } catch (error) {
      // A lookup failure or unknown id never started a run: no state, no audit.
      if (!workflow) throw error;
      const message = clampErrorMessage(error);
      await store.updateWorkflowState(projectId, workflowId, { lastStatus: 'error', lastError: message, updatedAt: now() }).catch(() => undefined);
      await audit(projectId, { kind: 'workflow', status: 'error', projectId, workflowId, error: message, detail: { reason } });
      throw error;
    } finally {
      runningWorkflows.delete(key);
    }
  };

  /**
   * Fire one trigger by id: resolve its target, run the linked workflow or
   * scheduled task, record state and audit. Webhook auth is verified by the
   * route before calling this; internal callers pass `verified: true`.
   */
  const fireTrigger = async (projectId, triggerId, { reason = 'webhook', payload = null, verified = true } = {}) => {
    const triggers = await store.listTriggers(projectId);
    const trigger = triggers.find((entry) => entry.id === triggerId);
    if (!trigger) {
      const error = new Error('trigger not found');
      error.statusCode = 404;
      throw error;
    }
    if (trigger.enabled === false) {
      return { ok: false, skipped: true, reason: 'disabled' };
    }
    if (!verified) {
      const error = new Error('trigger verification failed');
      error.statusCode = 401;
      throw error;
    }

    await store.updateTriggerState(projectId, triggerId, { lastStatus: 'running', lastRunAt: now(), lastError: undefined, updatedAt: now() });
    emitEvent('novacode:automation.trigger.fired', { projectId, triggerId, reason, at: now() });

    let outcome = { ok: true };
    try {
      if (trigger.targetWorkflowId) {
        outcome = await runWorkflow(projectId, trigger.targetWorkflowId, { reason: `trigger:${reason}` });
      } else if (trigger.targetTaskId) {
        // Defer to the scheduled-task runtime through the service when wired;
        // otherwise record that the trigger has no runner in this process.
        outcome = { ok: true, deferred: true, targetTaskId: trigger.targetTaskId };
      }
      const status = outcome?.ok === false ? 'error' : 'success';
      await store.updateTriggerState(projectId, triggerId, {
        lastStatus: status,
        lastRunAt: now(),
        lastError: status === 'error' ? clampErrorMessage(outcome?.error || outcome?.status) : undefined,
        updatedAt: now(),
      });
      const auditEntry = {
        kind: 'trigger',
        status,
        projectId,
        triggerId,
        detail: { reason },
      };
      if (isObjectRecord(payload)) {
        auditEntry.detail.payloadKeys = Object.keys(payload).slice(0, 20);
      }
      if (outcome?.sessionId) auditEntry.sessionId = outcome.sessionId;
      if (status === 'error') auditEntry.error = clampErrorMessage(outcome?.error || outcome?.status);
      await audit(projectId, auditEntry);
      const fireResult = { ok: status !== 'error', triggerId };
      if (isObjectRecord(outcome)) {
        Object.assign(fireResult, outcome);
      }
      return fireResult;
    } catch (error) {
      const message = clampErrorMessage(error);
      await store.updateTriggerState(projectId, triggerId, { lastStatus: 'error', lastError: message, updatedAt: now() }).catch(() => undefined);
      await audit(projectId, { kind: 'trigger', status: 'error', projectId, triggerId, error: message, detail: { reason } });
      throw error;
    }
  };

  /**
   * Handle an inbound HTTP webhook: verify the secret, pick matching triggers,
   * fire each. Returns a summary without leaking secrets.
   */
  const handleWebhook = async (projectId, { headers = {}, body = null } = {}) => {
    const triggers = await store.listTriggers(projectId);
    const matches = findMatchingWebhookTriggers(triggers, { headers, body });
    if (matches.length === 0) {
      const anyEnabled = triggers.some((entry) => entry.kind === 'webhook' && entry.enabled !== false);
      const error = new Error(anyEnabled ? 'invalid webhook secret' : 'no webhook triggers configured');
      error.statusCode = anyEnabled ? 401 : 404;
      throw error;
    }
    const results = [];
    for (const trigger of matches) {
      try {
        const payloadBody = isObjectRecord(body) ? body : null;
        results.push(await fireTrigger(projectId, trigger.id, { reason: 'webhook', payload: payloadBody, verified: true }));
      } catch (error) {
        results.push({ ok: false, triggerId: trigger.id, error: clampErrorMessage(error) });
      }
    }
    return { ok: results.every((entry) => entry.ok !== false), results };
  };

  /**
   * Publish an internal event (session finished, scheduled task failed) and
   * fire every matching event trigger.
   */
  const publishEvent = async (projectId, eventKind, properties = {}) => {
    const event = buildAutomationEvent(eventKind, properties);
    const triggers = await store.listTriggers(projectId);
    const matches = findMatchingEventTriggers(triggers, event.kind);
    const results = [];
    for (const trigger of matches) {
      try {
        results.push(await fireTrigger(projectId, trigger.id, { reason: `event:${event.kind}`, payload: event.properties, verified: true }));
      } catch (error) {
        results.push({ ok: false, triggerId: trigger.id, error: clampErrorMessage(error) });
      }
    }
    return { event, results };
  };

  /**
   * Reply to a journaled approval against OpenCode, then mark it resolved.
   */
  const replyApproval = async (entry, decision) => {
    if (!entry?.permissionId) return { ok: false };
    if (!buildOpenCodeUrl) return { ok: false, reason: 'no-opencode-url' };
    const reply = decision === 'approved' ? 'once' : 'no';
    const url = new URL(`${baseUrl()}/permission/${encodeURIComponent(entry.permissionId)}/reply`);
    if (entry.directory) url.searchParams.set('directory', entry.directory);
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ reply }),
        signal: AbortSignal.timeout(5000),
      });
      approvalJournal.resolve(entry.permissionId, decision);
      return { ok: response.ok, status: response.status };
    } catch (error) {
      logger.warn?.('[automation] approval reply failed:', error?.message ?? error);
      return { ok: false, error: clampErrorMessage(error) };
    }
  };

  /**
   * Feed a permission request through the policy engine and journal holds for
   * the approval inbox. Safe to call for every `permission.asked` event.
   */
  const handlePermissionAsk = async (permission, directory) => {
    if (!permission?.id) return null;
    const verdict = await policyEngine.evaluateForAutoAccept(permission);
    if (verdict && (verdict.action === 'hold')) {
      const journalEntry = {
        permissionId: permission.id,
        sessionId: permission.sessionID ?? null,
        directory: directory ?? permission.directory ?? null,
        action: 'hold',
        title: permission.title ?? permission.command ?? permission.path ?? null,
      };
      if (verdict.ruleId) journalEntry.ruleId = verdict.ruleId;
      if (verdict.ruleName) journalEntry.ruleName = verdict.ruleName;
      approvalJournal.record(journalEntry);
    }
    return verdict;
  };

  /**
   * Permission-auto-accept adapter: compose automation policy ahead of the
   * existing routing safety net.
   */
  const evaluatePermission = async (permission, directory) => {
    const inner = await policyEngine.evaluateForAutoAccept(permission);
    if (inner) return inner;
    return null;
  };

  const getStatus = () => ({
    runningWorkflows: runningWorkflows.size,
    pendingApprovals: approvalJournal.list().length,
    policyRevision: policyEngine.snapshot().revision,
  });

  const start = async () => {
    try {
      await policyEngine.load();
    } catch (error) {
      logger.warn?.('[automation] policy load failed:', error?.message ?? error);
    }
    return getStatus();
  };

  const stop = () => {
    runningWorkflows.clear();
  };

  const runtimeApi = {
    store,
    policyEngine,
    approvalJournal,
    service: null,
    listTriggers: (projectId) => store.listTriggers(projectId),
    listWorkflows: (projectId) => store.listWorkflows(projectId),
    upsertTrigger: (projectId, input) => store.upsertTrigger(projectId, input),
    deleteTrigger: (projectId, id) => store.deleteTrigger(projectId, id),
    upsertWorkflow: (projectId, input) => store.upsertWorkflow(projectId, input),
    deleteWorkflow: (projectId, id) => store.deleteWorkflow(projectId, id),
    runWorkflow,
    fireTrigger,
    handleWebhook,
    publishEvent,
    replyApproval,
    handlePermissionAsk,
    evaluatePermission,
    getStatus,
    start,
    stop,
    ensureProjectPath,
    resolveProjectIdForDirectory,
    audit,
    listAudit: (projectId, options) => store.listAudit(projectId, options),
    readPolicy: () => policyEngine.load(),
    writePolicy: (input) => policyEngine.save(input),
    listApprovals: (options) => Promise.resolve({ approvals: approvalJournal.list(options) }),
    resolveApproval: async (permissionId, decision) => {
      const entry = approvalJournal.resolve(permissionId, decision);
      if (!entry) {
        const error = new Error('approval not found');
        error.statusCode = 404;
        throw error;
      }
      await replyApproval(entry, decision);
      return { approval: entry };
    },
    verifyWebhookSecret,
    // Re-exports so routes and tests can import from one place.
    schema: {
      normalizeTrigger,
      normalizeWorkflow,
      normalizePolicyRule,
      normalizePolicyDocument,
      normalizeAuditEntry,
      evaluatePolicyRules,
      AUTOMATION_EVENT_KINDS,
      AUTOMATION_TRIGGER_KINDS,
      AUTOMATION_WORKFLOW_STEP_KINDS,
      AUTOMATION_POLICY_ACTIONS,
      AUTOMATION_ON_FAIL_ACTIONS,
      AUTOMATION_POLICY_RULES_MAX,
      AUTOMATION_SECRET_MIN_LENGTH,
      AUTOMATION_SECRET_MAX_LENGTH,
      AUTOMATION_WORKFLOW_MAX_STEPS,
      AUTOMATION_NAME_MAX_LENGTH,
      AUTOMATION_PROMPT_MAX_LENGTH,
      AUTOMATION_LAST_ERROR_MAX_LENGTH,
      AUTOMATION_AUDIT_ENTRY_MAX_LENGTH,
    },
    executeWorkflowStep,
    runShellStep,
    runPromptStep,
    decideStepOutcome,
    createBudgetTracker,
    runWithRetries,
    computeRetryDelay,
    buildEscalation,
    clampErrorMessage,
  };

  // Wire the service after the API object exists so its `getRuntime` thunk
  // can resolve this runtime without a circular constructor reference.
  runtimeApi.service = createAutomationService({
    store,
    policyEngine,
    approvalJournal,
    getRuntime: () => runtimeApi,
  });

  return runtimeApi;
};
