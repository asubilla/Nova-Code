import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideStepOutcome,
  executeWorkflowStep,
  runShellStep,
  runWorkflow,
} from './workflows.js';
import { createBudgetTracker } from './retries.js';

const shellStep = (overrides = {}) => ({
  id: 's1',
  name: 'Echo',
  kind: 'shell',
  command: 'echo hello',
  onFail: 'stop',
  ...overrides,
});

const promptStep = (overrides = {}) => ({
  id: 'p1',
  name: 'Prompt',
  kind: 'prompt',
  prompt: 'Do the thing',
  providerID: 'openai',
  modelID: 'gpt-5',
  waitForIdle: false,
  onFail: 'stop',
  ...overrides,
});

const buildWorkflow = (steps, overrides = {}) => ({
  id: 'wf1',
  name: 'Test workflow',
  enabled: true,
  steps,
  ...overrides,
});

describe('runShellStep', () => {
  it('runs a successful command and captures stdout', async () => {
    const result = await runShellStep({ command: 'echo shell-ok' });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('shell-ok');
  });

  it('reports a non-zero exit as failure', async () => {
    const result = await runShellStep({ command: process.platform === 'win32' ? 'exit /b 7' : 'exit 7' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 7/);
  });

  it('times out a hanging command', async () => {
    const command = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 30"'
      : 'sleep 30';
    const result = await runShellStep({ command, timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/timed out/);
  }, 15_000);
});

describe('executeWorkflowStep', () => {
  it('runs a shell step with context cwd', async () => {
    const result = await executeWorkflowStep({
      step: shellStep({ command: 'echo step-ok' }),
      context: { projectPath: process.cwd() },
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('step-ok');
    expect(result.stepId).toBe('s1');
  });

  it('returns a structured failure for a bad shell step', async () => {
    const result = await executeWorkflowStep({
      step: shellStep({ command: process.platform === 'win32' ? 'exit /b 1' : 'exit 1' }),
      context: { projectPath: process.cwd() },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('runs a prompt step by dispatching prompt_async', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(String(url)).toContain('/prompt_async');
      const body = JSON.parse(options.body);
      expect(body.parts[0].text).toBe('Do the thing');
      return { ok: true, json: async () => ({}) };
    });
    const createSession = vi.fn(async () => 'ses_1');
    const result = await executeWorkflowStep({
      step: promptStep(),
      context: {
        projectPath: '/repo',
        baseUrl: 'http://localhost:4096',
        authHeaders: {},
        fetchImpl,
        createSession,
        sleep: async () => {},
      },
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('ses_1');
    expect(createSession).toHaveBeenCalledWith({ directory: '/repo', title: 'Prompt' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing sessionID without creating one', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const createSession = vi.fn();
    const context = {
      projectPath: '/repo',
      baseUrl: 'http://localhost:4096',
      authHeaders: {},
      fetchImpl,
      createSession,
      sessionID: 'existing',
      sleep: async () => {},
    };
    const result = await executeWorkflowStep({ step: promptStep(), context });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('existing');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('propagates sessionID back onto shared context', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const context = {
      projectPath: '/repo',
      baseUrl: 'http://localhost:4096',
      authHeaders: {},
      fetchImpl,
      createSession: async () => 'ses_ctx',
      sleep: async () => {},
    };
    await executeWorkflowStep({ step: promptStep(), context });
    expect(context.sessionID).toBe('ses_ctx');
  });

  it('returns failure when prompt_async responds non-ok', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    const result = await executeWorkflowStep({
      step: promptStep(),
      context: {
        projectPath: '/repo',
        baseUrl: 'http://localhost:4096',
        authHeaders: {},
        fetchImpl,
        createSession: async () => 's',
        sleep: async () => {},
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/prompt_async failed \(500\)/);
  });
});

describe('decideStepOutcome', () => {
  it('moves to the next step on success', () => {
    expect(decideStepOutcome({ step: shellStep(), result: { ok: true }, retriesRemaining: 0 }))
      .toEqual({ action: 'next', status: 'success' });
  });

  it('stops on failure when onFail is stop', () => {
    expect(decideStepOutcome({ step: shellStep({ onFail: 'stop' }), result: { ok: false }, retriesRemaining: 3 }).action)
      .toBe('stop');
  });

  it('continues when onFail is continue', () => {
    expect(decideStepOutcome({ step: shellStep({ onFail: 'continue' }), result: { ok: false }, retriesRemaining: 0 }))
      .toMatchObject({ action: 'next', status: 'step_failed_continue' });
  });

  it('retries when onFail is retry and budget remains', () => {
    expect(decideStepOutcome({ step: shellStep({ onFail: 'retry' }), result: { ok: false }, retriesRemaining: 2 }))
      .toMatchObject({ action: 'retry', retriesRemaining: 1 });
  });

  it('stops when retries are exhausted', () => {
    expect(decideStepOutcome({ step: shellStep({ onFail: 'retry' }), result: { ok: false }, retriesRemaining: 0 }).action)
      .toBe('stop');
  });
});

describe('runWorkflow', () => {
  let tempBase;
  beforeEach(() => {
    tempBase = process.cwd();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs ordered shell steps and succeeds', async () => {
    const order = [];
    const runStep = vi.fn(async ({ step }) => {
      order.push(step.id);
      return { stepId: step.id, kind: step.kind, ok: true, startedAt: Date.now(), finishedAt: Date.now() };
    });
    const workflow = buildWorkflow([
      shellStep({ id: 'a', command: 'x' }),
      shellStep({ id: 'b', command: 'y' }),
    ]);
    const result = await runWorkflow({
      workflow,
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(order).toEqual(['a', 'b']);
    expect(result.stepResults).toHaveLength(2);
    expect(result.budget.attempt).toBe(2);
  });

  it('stops at the first failing step when onFail is stop', async () => {
    const runStep = vi.fn(async ({ step }) => (
      step.id === 'a'
        ? { stepId: 'a', kind: 'shell', ok: false, error: 'first failed', startedAt: 1, finishedAt: 2 }
        : { stepId: 'b', kind: 'shell', ok: true, startedAt: 1, finishedAt: 2 }
    ));
    const result = await runWorkflow({
      workflow: buildWorkflow([shellStep({ id: 'a' }), shellStep({ id: 'b' })]),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('step_failed');
    expect(result.stepResults).toHaveLength(1);
    expect(result.error).toBe('first failed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBeTruthy();
  });

  it('continues past a failed step when onFail is continue', async () => {
    const runStep = vi.fn(async ({ step }) => (
      step.id === 'a'
        ? { stepId: 'a', kind: 'shell', ok: false, error: 'soft fail', startedAt: 1, finishedAt: 2 }
        : { stepId: 'b', kind: 'shell', ok: true, startedAt: 1, finishedAt: 2 }
    ));
    const result = await runWorkflow({
      workflow: buildWorkflow([
        shellStep({ id: 'a', onFail: 'continue' }),
        shellStep({ id: 'b' }),
      ]),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      sleep: async () => {},
    });
    expect(result.stepResults).toHaveLength(2);
    expect(result.status).toBe('completed_with_errors');
    expect(result.ok).toBe(false);
  });

  it('retries a failing step when onFail is retry and maxRetries allows it', async () => {
    let calls = 0;
    const runStep = vi.fn(async ({ step }) => {
      calls += 1;
      if (calls < 2) return { stepId: step.id, kind: 'shell', ok: false, error: 'flaky', startedAt: 1, finishedAt: 2 };
      return { stepId: step.id, kind: 'shell', ok: true, startedAt: 1, finishedAt: 2 };
    });
    const result = await runWorkflow({
      workflow: buildWorkflow([shellStep({ onFail: 'retry' })], { retry: { maxRetries: 3, backoffMs: 1 } }),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(result.stepResults[0].retriesUsed).toBe(1);
  });

  it('rejects an empty workflow', async () => {
    const result = await runWorkflow({
      workflow: buildWorkflow([]),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid');
  });

  it('skips a disabled workflow', async () => {
    const result = await runWorkflow({
      workflow: buildWorkflow([shellStep()], { enabled: false }),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      sleep: async () => {},
    });
    expect(result.status).toBe('disabled');
  });

  it('stops with budget_exhausted when the token budget is pre-breached', async () => {
    const budget = createBudgetTracker({ maxTokens: 10 });
    budget.consume(50);
    const runStep = vi.fn();
    const result = await runWorkflow({
      workflow: buildWorkflow([shellStep()]),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      budget,
      sleep: async () => {},
    });
    expect(result.status).toBe('budget_exhausted');
    expect(runStep).not.toHaveBeenCalled();
    expect(result.escalated).toBeTruthy();
  });

  it('invokes onStep for each completed step', async () => {
    const onStep = vi.fn();
    const runStep = vi.fn(async ({ step }) => ({ stepId: step.id, kind: 'shell', ok: true, startedAt: 1, finishedAt: 2 }));
    await runWorkflow({
      workflow: buildWorkflow([shellStep({ id: 'a' }), shellStep({ id: 'b' })]),
      projectPath: tempBase,
      baseUrl: 'http://x',
      authHeaders: {},
      runStep,
      onStep,
      sleep: async () => {},
    });
    expect(onStep).toHaveBeenCalledTimes(2);
  });
});
