import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAutomationRuntime } from './runtime.js';
import { createAutomationStore } from './store.js';

let tempRoot;
let store;
let events;
let escalations;

const workflowShell = {
  id: 'wf-ok',
  name: 'OK pipeline',
  enabled: true,
  steps: [{ id: 'a', name: 'Echo', kind: 'shell', command: 'echo runtime-ok', onFail: 'stop' }],
};

const workflowFail = {
  id: 'wf-fail',
  name: 'Failing pipeline',
  enabled: true,
  steps: [{ id: 'a', name: 'Boom', kind: 'shell', command: process.platform === 'win32' ? 'exit /b 1' : 'exit 1', onFail: 'stop' }],
};

const makeRuntime = (overrides = {}) => {
  events = [];
  escalations = [];
  return createAutomationRuntime({
    store,
    broadcastGlobalUiEvent: (event) => { events.push(event); },
    emitEscalation: (escalation) => { escalations.push(escalation); },
    listProjects: async () => [{ id: 'proj-1', path: tempRoot }],
    buildOpenCodeUrl: (suffix) => `http://127.0.0.1:4096${suffix}`,
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    sleep: async () => {},
    ...overrides,
  });
};

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-automation-rt-'));
  store = createAutomationStore({ dataDir: tempRoot });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('automation runtime workflow', () => {
  it('runs a shell workflow to success and records audit + state', async () => {
    const runtime = makeRuntime();
    await store.upsertWorkflow('proj-1', workflowShell);
    const report = await runtime.runWorkflow('proj-1', 'wf-ok');
    expect(report.ok).toBe(true);
    expect(report.status).toBe('success');

    const workflows = await store.listWorkflows('proj-1');
    expect(workflows[0].state.lastStatus).toBe('success');

    const audit = await store.listAudit('proj-1');
    expect(audit[0]).toMatchObject({ kind: 'workflow', status: 'success', workflowId: 'wf-ok' });
    expect(events.some((event) => event.type === 'novacode:automation.workflow.finished')).toBe(true);
  });

  it('records a failing workflow with escalation', async () => {
    const runtime = makeRuntime();
    await store.upsertWorkflow('proj-1', workflowFail);
    const report = await runtime.runWorkflow('proj-1', 'wf-fail');
    expect(report.ok).toBe(false);
    expect(report.escalated).toBeTruthy();
    expect(escalations).toHaveLength(1);

    const workflows = await store.listWorkflows('proj-1');
    expect(workflows[0].state.lastStatus).toBe('error');
    expect(workflows[0].state.lastError).toBeTruthy();

    const audit = await store.listAudit('proj-1');
    expect(audit[0]).toMatchObject({ kind: 'workflow', status: 'error' });
  });

  it('throws 404 for an unknown workflow', async () => {
    const runtime = makeRuntime();
    const error = await runtime.runWorkflow('proj-1', 'missing').catch((err) => err);
    expect(error.statusCode).toBe(404);
  });

  it('runs a shell-only workflow even when the OpenCode port is unavailable', async () => {
    const runtime = makeRuntime({
      waitForOpenCodeReady: async () => {
        throw new Error('OpenCode port is not available');
      },
      buildOpenCodeUrl: () => {
        throw new Error('OpenCode port is not available');
      },
      getOpenCodeAuthHeaders: () => {
        throw new Error('OpenCode port is not available');
      },
    });
    await store.upsertWorkflow('proj-1', workflowShell);
    const report = await runtime.runWorkflow('proj-1', 'wf-ok');
    expect(report.ok).toBe(true);
    expect(report.status).toBe('success');
  });

  it('rejects a concurrent run of the same workflow', async () => {
    const runtime = makeRuntime();
    await store.upsertWorkflow('proj-1', {
      ...workflowShell,
      steps: [{
        id: 'a',
        name: 'Slow',
        kind: 'shell',
        command: process.platform === 'win32' ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 2"' : 'sleep 2',
        onFail: 'stop',
      }],
    });
    const first = runtime.runWorkflow('proj-1', 'wf-ok');
    const second = await runtime.runWorkflow('proj-1', 'wf-ok');
    expect(second).toMatchObject({ ok: false, running: true });
    await first;
  }, 15_000);
});

describe('automation runtime triggers', () => {
  beforeEach(async () => {
    await store.upsertWorkflow('proj-1', workflowShell);
  });

  it('fires a webhook trigger that targets a workflow', async () => {
    const runtime = makeRuntime();
    const { trigger } = await store.upsertTrigger('proj-1', {
      name: 'Hook',
      kind: 'webhook',
      secret: 's'.repeat(24),
      targetWorkflowId: 'wf-ok',
    });
    const result = await runtime.fireTrigger('proj-1', trigger.id, { reason: 'webhook' });
    expect(result.ok).toBe(true);

    const triggers = await store.listTriggers('proj-1');
    expect(triggers[0].state.lastStatus).toBe('success');

    const audit = await store.listAudit('proj-1');
    expect(audit.some((entry) => entry.kind === 'trigger')).toBe(true);
  });

  it('skips a disabled trigger', async () => {
    const runtime = makeRuntime();
    const { trigger } = await store.upsertTrigger('proj-1', {
      name: 'Hook',
      kind: 'webhook',
      secret: 's'.repeat(24),
      targetWorkflowId: 'wf-ok',
      enabled: false,
    });
    const result = await runtime.fireTrigger('proj-1', trigger.id);
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'disabled' });
  });

  it('rejects an unverified fire with 401', async () => {
    const runtime = makeRuntime();
    const { trigger } = await store.upsertTrigger('proj-1', {
      name: 'Hook',
      kind: 'webhook',
      secret: 's'.repeat(24),
      targetWorkflowId: 'wf-ok',
    });
    const error = await runtime.fireTrigger('proj-1', trigger.id, { verified: false }).catch((err) => err);
    expect(error.statusCode).toBe(401);
  });

  it('throws 404 for an unknown trigger', async () => {
    const runtime = makeRuntime();
    const error = await runtime.fireTrigger('proj-1', 'nope').catch((err) => err);
    expect(error.statusCode).toBe(404);
  });

  it('handleWebhook rejects a wrong secret with 401', async () => {
    const runtime = makeRuntime();
    await store.upsertTrigger('proj-1', {
      name: 'Hook',
      kind: 'webhook',
      secret: 's'.repeat(24),
      targetWorkflowId: 'wf-ok',
    });
    const error = await runtime.handleWebhook('proj-1', {
      headers: { 'x-webhook-secret': 'wrong-secret-value' },
      body: null,
    }).catch((err) => err);
    expect(error.statusCode).toBe(401);
  });

  it('handleWebhook fires matching triggers for a valid secret', async () => {
    const runtime = makeRuntime();
    const { trigger } = await store.upsertTrigger('proj-1', {
      name: 'Hook',
      kind: 'webhook',
      secret: 's'.repeat(24),
      targetWorkflowId: 'wf-ok',
    });
    const result = await runtime.handleWebhook('proj-1', {
      headers: { 'x-webhook-secret': 's'.repeat(24) },
      body: { hello: 'world' },
    });
    expect(result.ok).toBe(true);
    expect(result.results[0].triggerId).toBe(trigger.id);
  });

  it('handleWebhook returns 404 when no webhook triggers exist', async () => {
    const runtime = makeRuntime();
    const error = await runtime.handleWebhook('proj-1', { headers: {}, body: null }).catch((err) => err);
    expect(error.statusCode).toBe(404);
  });

  it('publishEvent fans out to matching event triggers only', async () => {
    const runtime = makeRuntime();
    const { trigger } = await store.upsertTrigger('proj-1', {
      name: 'On finish',
      kind: 'event',
      eventKind: 'session.finished',
      targetWorkflowId: 'wf-ok',
    });
    await store.upsertTrigger('proj-1', {
      name: 'On fail',
      kind: 'event',
      eventKind: 'session.failed',
      targetWorkflowId: 'wf-ok',
    });

    const miss = await runtime.publishEvent('proj-1', 'session.failed', { sessionId: 's1' });
    expect(miss.results).toHaveLength(1);
    expect(miss.results[0].triggerId).not.toBe(trigger.id);

    const hit = await runtime.publishEvent('proj-1', 'session.finished', { sessionId: 's1' });
    expect(hit.results).toHaveLength(1);
    expect(hit.results[0].triggerId).toBe(trigger.id);
    expect(hit.event.kind).toBe('session.finished');
  });
});

describe('automation runtime policy and approvals', () => {
  it('evaluates policy and journals holds for the approval inbox', async () => {
    const runtime = makeRuntime();
    await runtime.writePolicy({
      rules: [{ id: 'h1', name: 'hold edits', action: 'hold', enabled: true, toolPattern: 'edit' }],
    });

    const verdict = await runtime.handlePermissionAsk({
      id: 'perm-1',
      sessionID: 'ses-1',
      permission: 'edit',
      path: 'src/a.ts',
    }, '/repo');

    expect(verdict).toMatchObject({ action: 'hold', source: 'automation-policy' });
    const { approvals } = await runtime.listApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].permissionId).toBe('perm-1');
    expect(approvals[0].ruleId).toBe('h1');
  });

  it('does not journal accept verdicts', async () => {
    const runtime = makeRuntime();
    await runtime.writePolicy({
      rules: [{ id: 'a1', name: 'accept tests', action: 'accept', enabled: true, toolPattern: 'bash' }],
    });
    const verdict = await runtime.handlePermissionAsk({ id: 'perm-2', permission: 'bash', command: 'npm test' }, '/repo');
    expect(verdict.action).toBe('accept');
    const { approvals } = await runtime.listApprovals();
    expect(approvals).toHaveLength(0);
  });

  it('evaluatePermission returns null when no rule matches', async () => {
    const runtime = makeRuntime();
    expect(await runtime.evaluatePermission({ permission: 'webfetch' }, '/repo')).toBeNull();
  });

  it('resolveApproval marks the entry and replies via fetch', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const runtime = makeRuntime({ fetchImpl });
    runtime.approvalJournal.record({ permissionId: 'perm-3', action: 'hold', directory: '/repo' });
    const { approval } = await runtime.resolveApproval('perm-3', 'approved');
    expect(approval.status).toBe('approved');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/permission/perm-3/reply');
    expect(JSON.parse(options.body)).toEqual({ reply: 'once' });
  });

  it('resolveApproval denies with reply no', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const runtime = makeRuntime({ fetchImpl });
    runtime.approvalJournal.record({ permissionId: 'perm-4', action: 'hold' });
    await runtime.resolveApproval('perm-4', 'denied');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ reply: 'no' });
  });

  it('throws 404 when resolving an unknown approval', async () => {
    const runtime = makeRuntime();
    const error = await runtime.resolveApproval('missing', 'approved').catch((err) => err);
    expect(error.statusCode).toBe(404);
  });
});

describe('automation runtime status lifecycle', () => {
  it('reports status and loads policy on start', async () => {
    const runtime = makeRuntime();
    const status = await runtime.start();
    expect(status).toMatchObject({ runningWorkflows: 0, pendingApprovals: 0 });
    expect(Number.isFinite(status.policyRevision)).toBe(true);
    runtime.stop();
    expect(runtime.getStatus().runningWorkflows).toBe(0);
  });

  it('exposes a service wired back to this runtime', async () => {
    const runtime = makeRuntime();
    expect(runtime.service).toBeTruthy();
    await runtime.service.list('proj-1');
    // runWorkflow through the service resolves the runtime thunk
    await store.upsertWorkflow('proj-1', workflowShell);
    const report = await runtime.service.runWorkflow('proj-1', 'wf-ok');
    expect(report.ok).toBe(true);
  });
});
