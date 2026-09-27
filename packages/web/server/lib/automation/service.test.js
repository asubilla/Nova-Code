import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAutomationStore } from './store.js';
import { createAutomationService } from './service.js';

let tempRoot;
let store;
let service;

const webhookTrigger = {
  name: 'Hook',
  kind: 'webhook',
  secret: 's'.repeat(24),
  targetTaskId: 'task-1',
};

const workflowInput = {
  name: 'Pipeline',
  steps: [
    { name: 'Prompt', kind: 'prompt', prompt: 'do it', providerID: 'openai', modelID: 'gpt-5' },
    { name: 'Shell', kind: 'shell', command: 'npm test' },
  ],
};

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-automation-svc-'));
  store = createAutomationStore({ dataDir: tempRoot });
  service = createAutomationService({ store });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('automation service list', () => {
  it('returns empty collections for a fresh project', async () => {
    await expect(service.list('proj-1')).resolves.toEqual({ triggers: [], workflows: [] });
  });

  it('hides webhook secrets from the list payload', async () => {
    await store.upsertTrigger('proj-1', webhookTrigger);
    const result = await service.list('proj-1');
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].secret).toBeUndefined();
    expect(result.triggers[0].kind).toBe('webhook');
  });

  it('rejects a missing projectId', async () => {
    await expect(service.list('  ')).rejects.toThrow('projectId is required');
    expect((await service.list('x').catch((error) => error)).statusCode).toBeUndefined();
  });
});

describe('automation service CRUD', () => {
  it('upserts and removes a trigger without echoing the secret', async () => {
    const created = await service.upsertTrigger('proj-1', webhookTrigger);
    expect(created.trigger.secret).toBeUndefined();
    expect(created.created).toBe(true);
    // The store also returns the full list; that path must strip secrets too.
    expect(created.triggers).toHaveLength(1);
    expect(created.triggers[0].secret).toBeUndefined();
    expect(created.triggers[0].kind).toBe('webhook');

    const removed = await service.removeTrigger('proj-1', created.trigger.id);
    expect(removed.deleted).toBe(true);
    expect(removed.triggers).toHaveLength(0);
  });

  it('rejects an invalid trigger payload with 400', async () => {
    const error = await service.upsertTrigger('proj-1', null).catch((err) => err);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch('trigger payload');
  });

  it('upserts and removes a workflow', async () => {
    const created = await service.upsertWorkflow('proj-1', workflowInput);
    expect(created.workflow.steps).toHaveLength(2);
    const removed = await service.removeWorkflow('proj-1', created.workflow.id);
    expect(removed.deleted).toBe(true);
  });

  it('rejects a missing workflow id', async () => {
    const error = await service.removeWorkflow('proj-1', ' ').catch((err) => err);
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch('workflowId');
  });

  it('returns 503 when the runtime is unavailable for runWorkflow', async () => {
    const error = await service.runWorkflow('proj-1', 'wf1').catch((err) => err);
    expect(error.statusCode).toBe(503);
  });

  it('delegates runWorkflow to the runtime when present', async () => {
    const runtime = { runWorkflow: vi.fn(async () => ({ ok: true })) };
    const withRuntime = createAutomationService({ store, runtime });
    await withRuntime.runWorkflow('proj-1', 'wf1');
    expect(runtime.runWorkflow).toHaveBeenCalledWith('proj-1', 'wf1', { reason: 'manual' });
  });

  it('delegates fireTrigger to the runtime when present', async () => {
    const runtime = { fireTrigger: vi.fn(async () => ({ ok: true })) };
    const withRuntime = createAutomationService({ store, runtime });
    await withRuntime.fireTrigger('proj-1', 'trg1', { payload: { a: 1 } });
    expect(runtime.fireTrigger).toHaveBeenCalledWith('proj-1', 'trg1', { reason: 'manual', payload: { a: 1 } });
  });
});

describe('automation service policy and approvals', () => {
  it('loads and saves the policy', async () => {
    const empty = await service.getPolicy();
    expect(empty).toEqual({ rules: [], revision: 0 });
    const saved = await service.putPolicy({ rules: [{ name: 'Allow', action: 'accept', toolPattern: 'bash' }] });
    expect(saved.revision).toBe(1);
    expect(saved.rules).toHaveLength(1);
  });

  it('rejects a bad policy payload with 400', async () => {
    const error = await service.putPolicy(null).catch((err) => err);
    expect(error.statusCode).toBe(400);
  });

  it('returns an empty approval list when no journal is wired', async () => {
    await expect(service.listApprovals()).resolves.toEqual({ approvals: [] });
  });

  it('lists approvals from a wired journal', async () => {
    const { createApprovalJournal } = await import('./policy.js');
    const journal = createApprovalJournal();
    journal.record({ permissionId: 'p1', action: 'hold' });
    const withJournal = createAutomationService({ store, approvalJournal: journal });
    const { approvals } = await withJournal.listApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].permissionId).toBe('p1');
  });

  it('resolves an approval and notifies the runtime', async () => {
    const { createApprovalJournal } = await import('./policy.js');
    const journal = createApprovalJournal();
    journal.record({ permissionId: 'p1', action: 'hold' });
    const replyApproval = vi.fn(async () => {});
    const withJournal = createAutomationService({ store, approvalJournal: journal, runtime: { replyApproval } });
    const { approval } = await withJournal.resolveApproval('p1', 'approved');
    expect(approval.status).toBe('approved');
    expect(replyApproval).toHaveBeenCalledWith(approval, 'approved');
  });

  it('returns 404 for an unknown approval', async () => {
    const { createApprovalJournal } = await import('./policy.js');
    const journal = createApprovalJournal();
    const withJournal = createAutomationService({ store, approvalJournal: journal });
    const error = await withJournal.resolveApproval('missing', 'approved').catch((err) => err);
    expect(error.statusCode).toBe(404);
  });

  it('rejects an invalid decision', async () => {
    const { createApprovalJournal } = await import('./policy.js');
    const withJournal = createAutomationService({ store, approvalJournal: createApprovalJournal() });
    const error = await withJournal.resolveApproval('p1', 'maybe').catch((err) => err);
    expect(error.statusCode).toBe(400);
  });
});

describe('automation service audit', () => {
  it('lists audit entries for a project', async () => {
    await store.appendAudit('proj-1', { id: 'a1', kind: 'trigger', status: 'success', at: 1 });
    const { entries } = await service.listAudit('proj-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('trigger');
  });

  it('rejects a missing projectId for audit', async () => {
    await expect(service.listAudit('')).rejects.toThrow('projectId is required');
  });
});
