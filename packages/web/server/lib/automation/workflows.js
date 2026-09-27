import { spawn } from 'node:child_process';
import { evaluatePolicyRules } from './schema.js';
import { buildEscalation, clampErrorMessage, createBudgetTracker, runWithRetries } from './retries.js';

const DEFAULT_STEP_TIMEOUT_MS = 300_000;
const MAX_SHELL_TIMEOUT_MS = 60 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); });
const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

/**
 * Execute one shell step as a chained command. Uses the platform shell so
 * operators can pipe, &&, and sequence inside a single step the same way they
 * would in a terminal. Output is captured and truncated for the audit trail.
 */
export const runShellStep = ({ command, cwd, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, env = null, execFile = null } = {}) => {
  const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_STEP_TIMEOUT_MS, 1000), MAX_SHELL_TIMEOUT_MS);
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = (execFile ?? ((file, args, options, callback) => {
      const proc = spawn(file, args, { ...options, windowsHide: true });
      callback(proc);
    }))(shell, shellArgs, {
      cwd: isStringValue(cwd) && cwd ? cwd : process.cwd(),
      env: isObjectRecord(env) ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    }, (proc) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        finish({ ok: false, code: null, signal: null, timedOut: true, stdout, stderr, error: `step timed out after ${boundedTimeout}ms` });
      }, boundedTimeout);

      proc.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      proc.on('error', (error) => {
        finish({ ok: false, code: null, signal: null, timedOut: false, stdout, stderr, error: clampErrorMessage(error) });
      });
      proc.on('close', (code, signal) => {
        const truncatedOut = stdout.length > 8000 ? `${stdout.slice(0, 8000)}…` : stdout;
        const truncatedErr = stderr.length > 4000 ? `${stderr.slice(0, 4000)}…` : stderr;
        const shellResult = {
          ok: code === 0,
          code,
          signal: signal ?? null,
          timedOut: false,
          stdout: truncatedOut,
          stderr: truncatedErr,
        };
        if (code !== 0) {
          shellResult.error = `command exited with code ${code}${truncatedErr ? `: ${truncatedErr.trim().slice(0, 400)}` : ''}`;
        }
        finish(shellResult);
      });
    });
  });
};

/**
 * Run a single prompt step against an existing session (or create one when the
 * caller passes `createSession`). Mirrors the scheduled-task async prompt path
 * so automation and schedules share the same dispatch contract.
 */
export const runPromptStep = async ({
  step,
  projectPath,
  sessionID = null,
  baseUrl,
  authHeaders,
  fetchImpl = fetch,
  createSession = null,
  waitIdle = false,
  pollIntervalMs = 500,
  sleep = wait,
  now = Date.now,
}) => {
  const startedAt = now();
  let sessionId = sessionID;
  if (!sessionId && createSession) {
    sessionId = await createSession({ directory: projectPath, title: step.name });
  }
  if (!sessionId) throw new Error('prompt step requires a sessionID or createSession');

  const promptUrl = new URL(`${baseUrl.replace(/\/$/, '')}/session/${encodeURIComponent(sessionId)}/prompt_async`);
  promptUrl.searchParams.set('directory', projectPath);
  const payload = {
    model: { providerID: step.providerID, modelID: step.modelID },
    parts: [{ type: 'text', text: step.prompt }],
  };
  if (step.agent) payload.agent = step.agent;
  const response = await fetchImpl(promptUrl.toString(), {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`prompt_async failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  if (!waitIdle || !step.waitForIdle) {
    return { sessionId, waited: false, durationMs: Math.max(0, now() - startedAt) };
  }

  const timeoutMs = Math.min(Math.max(Number(step.timeoutMs) || DEFAULT_STEP_TIMEOUT_MS, 1000), MAX_SHELL_TIMEOUT_MS);
  const deadline = startedAt + timeoutMs;
  while (now() < deadline) {
    const statusUrl = new URL(`${baseUrl.replace(/\/$/, '')}/session/${encodeURIComponent(sessionId)}/status`);
    statusUrl.searchParams.set('directory', projectPath);
    const statusResponse = await fetchImpl(statusUrl.toString(), {
      headers: { ...authHeaders, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (statusResponse?.ok) {
      const info = await statusResponse.json().catch(() => null);
      const status = info?.data?.status ?? info?.status;
      if (status === 'completed' || status === 'idle') {
        return { sessionId, waited: true, status, durationMs: Math.max(0, now() - startedAt) };
      }
      if (status === 'error' || status === 'failed') {
        throw new Error(`session status ${status}`);
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`prompt step timed out after ${timeoutMs}ms waiting for idle`);
};

/**
 * Execute one workflow step by kind. Returns a normalized step result; it
 * never throws so the caller can apply the step's onFail policy.
 */
export const executeWorkflowStep = async ({ step, context }) => {
  const startedAt = Date.now();
  try {
    if (step.kind === 'shell') {
      const result = await runShellStep({
        command: step.command,
        cwd: context.projectPath,
        timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
        env: context.env,
      });
      const stepOutcome = {
        stepId: step.id,
        kind: step.kind,
        ok: result.ok,
        startedAt,
        finishedAt: Date.now(),
      };
      if (result.stdout) stepOutcome.stdout = result.stdout;
      if (result.stderr) stepOutcome.stderr = result.stderr;
      if (result.error) stepOutcome.error = result.error;
      if (Number.isFinite(result.code)) stepOutcome.exitCode = result.code;
      if (result.timedOut) stepOutcome.timedOut = true;
      return stepOutcome;
    }
    const result = await runPromptStep({
      step,
      projectPath: context.projectPath,
      sessionID: context.sessionID,
      baseUrl: context.baseUrl,
      authHeaders: context.authHeaders,
      fetchImpl: context.fetchImpl,
      createSession: context.createSession,
      sleep: context.sleep,
    });
    if (result.sessionId && !context.sessionID) context.sessionID = result.sessionId;
    const promptOutcome = {
      stepId: step.id,
      kind: step.kind,
      ok: true,
      startedAt,
      finishedAt: Date.now(),
    };
    if (result.sessionId) promptOutcome.sessionId = result.sessionId;
    if (result.waited) promptOutcome.waited = true;
    return promptOutcome;
  } catch (error) {
    return {
      stepId: step.id,
      kind: step.kind,
      ok: false,
      startedAt,
      finishedAt: Date.now(),
      error: clampErrorMessage(error),
    };
  }
};

/**
 * Decide what to do after a step result based on its onFail policy and whether
 * retries remain. `stop` aborts the run, `continue` moves to the next step,
 * `retry` re-runs the same step while attempt budget allows.
 */
export const decideStepOutcome = ({ step, result, retriesRemaining }) => {
  if (result?.ok) return { action: 'next', status: 'success' };
  const policy = step?.onFail || 'stop';
  if (policy === 'continue') return { action: 'next', status: 'step_failed_continue' };
  if (policy === 'retry' && retriesRemaining > 0) return { action: 'retry', status: 'step_failed_retry', retriesRemaining: retriesRemaining - 1 };
  return { action: 'stop', status: 'step_failed' };
};

/**
 * Run a multi-step workflow in order. Each step runs under the shared budget
 * and retry policy. Returns a full run report including per-step results —
 * one failed entity (step) never erases the history of earlier steps.
 */
export const runWorkflow = async ({
  workflow,
  projectPath,
  baseUrl,
  authHeaders,
  context: contextOverrides = {},
  runStep = executeWorkflowStep,
  budget: budgetOverride = null,
  sleep = wait,
  fetchImpl = fetch,
  createSession = null,
  onStep = null,
}) => {
  const startedAt = Date.now();
  if (!workflow || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    return { ok: false, status: 'invalid', error: 'workflow has no steps', stepResults: [], startedAt, finishedAt: Date.now() };
  }
  if (workflow.enabled === false) {
    return { ok: false, status: 'disabled', error: 'workflow is disabled', stepResults: [], startedAt, finishedAt: Date.now() };
  }

  const budget = budgetOverride ?? createBudgetTracker(workflow.budget ?? null, { startingAttempt: workflow.state?.attempt ?? 0, startingUsed: workflow.state?.budgetUsed ?? 0 });
  const maxRetries = Number.isFinite(workflow.retry?.maxRetries) ? Math.min(Math.floor(workflow.retry.maxRetries), 10) : 0;
  const backoffMs = Number.isFinite(workflow.retry?.backoffMs) ? Math.floor(workflow.retry.backoffMs) : 1000;

  const context = {
    projectPath,
    baseUrl,
    authHeaders,
    fetchImpl,
    createSession,
    sleep,
    sessionID: null,
    env: null,
    ...contextOverrides,
  };

  const stepResults = [];
  let status = 'success';
  let errorMessage = null;
  let escalated = null;

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    if (budget.breached) {
      status = 'budget_exhausted';
      errorMessage = budget.reason;
      break;
    }

    const retryOutcome = await runWithRetries(async () => {
      if (budget.breached) throw new Error(budget.reason);
      // Shell steps cost a flat 1000 "tokens" against the budget so a wall of
      // shell steps still trips the cap when maxTokens is set.
      if (step.kind === 'shell') budget.consume(1000);
      const result = await runStep({ step, context, budget });
      onStep?.({ step, result, index });
      if (!result.ok) throw Object.assign(new Error(result.error || 'step failed'), { stepResult: result });
      return result;
    }, {
      maxRetries: step.onFail === 'retry' ? maxRetries : 0,
      backoffMs,
      budget,
      sleep,
    });

    const stepResult = retryOutcome.value
      ?? retryOutcome.attempts[retryOutcome.attempts.length - 1]?.errorStepResult
      ?? retryOutcome.error?.stepResult
      ?? {
        stepId: step.id,
        kind: step.kind,
        ok: false,
        error: retryOutcome.error || 'step failed',
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };

    const pushed = {
      ...stepResult,
      ok: retryOutcome.ok,
      retriesUsed: retryOutcome.retriesUsed,
      budget: budget.snapshot(),
    };
    if (!retryOutcome.ok) pushed.error = retryOutcome.error || stepResult.error;
    stepResults.push(pushed);

    if (retryOutcome.ok) {
      if (budget.breached) {
        status = 'budget_exhausted';
        errorMessage = budget.reason;
        break;
      }
      continue;
    }

    if (retryOutcome.status === 'budget_exhausted') {
      status = 'budget_exhausted';
      errorMessage = retryOutcome.error;
      break;
    }

    const decision = decideStepOutcome({
      step,
      result: { ok: false, error: retryOutcome.error },
      retriesRemaining: 0,
    });
    if (decision.action === 'next') {
      status = decision.status === 'step_failed_continue' && status === 'success' ? 'completed_with_errors' : status;
      if (status !== 'budget_exhausted') status = status === 'success' ? 'completed_with_errors' : status;
      continue;
    }
    status = decision.status === 'step_failed_retry' ? 'error' : decision.status;
    errorMessage = retryOutcome.error;
    if (step.onFail === 'retry') status = 'error';
    break;
  }

  const finishedAt = Date.now();
  const ok = status === 'success';
  if (!ok && errorMessage) {
    escalated = buildEscalation({
      kind: 'workflow',
      name: workflow.name,
      projectId: contextOverrides.projectId,
      error: errorMessage,
      attempt: budget.attempt,
      maxAttempts: budget.maxAttempts ?? budget.attempt,
      sessionId: context.sessionID,
    });
  }

  const report = {
    ok,
    status,
    stepResults,
    sessionId: context.sessionID,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    budget: budget.snapshot(),
  };
  if (errorMessage) report.error = errorMessage;
  if (escalated) report.escalated = escalated;
  return report;
};
