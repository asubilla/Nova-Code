import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAutomationStore } from './store.js';

let tempRoot;
let store;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-automation-'));
  store = createAutomationStore({ dataDir: tempRoot });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const webhookInput = {
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

describe('automation store triggers', () => {
  it('creates, lists, updates, and deletes a trigger', async () => {
    const { trigger, created } = await store.upsertTrigger('proj-1', webhookInput);
    expect(created).toBe(true);
    expect(trigger.id).toMatch(/^trg_/);

    const listed = await store.listTriggers('proj-1');
    expect(listed).toHaveLength(1);

    const updated = await store.upsertTrigger('proj-1', { ...webhookInput, id: trigger.id, enabled: false });
    expect(updated.trigger.enabled).toBe(false);
    expect(updated.created).toBe(false);
    expect(updated.trigger.secret).toBe(webhookInput.secret);

    const removed = await store.deleteTrigger('proj-1', trigger.id);
    expect(removed.deleted).toBe(true);
    expect(await store.listTriggers('proj-1')).toHaveLength(0);
  });

  it('rejects deleting a missing trigger id', async () => {
    await expect(store.deleteTrigger('proj-1', '')).rejects.toThrow('triggerId is required');
  });

  it('scopes triggers per project', async () => {
    await store.upsertTrigger('proj-1', webhookInput);
    await store.upsertTrigger('proj-2', { ...webhookInput, name: 'Other' });
    expect(await store.listTriggers('proj-1')).toHaveLength(1);
    expect(await store.listTriggers('proj-2')).toHaveLength(1);
    expect((await store.listTriggers('proj-2'))[0].name).toBe('Other');
  });

  it('rejects an invalid project id', async () => {
    await expect(store.listTriggers('../escape')).rejects.toThrow('unsupported characters');
  });

  it('updates trigger state independently', async () => {
    const { trigger } = await store.upsertTrigger('proj-1', webhookInput);
    const result = await store.updateTriggerState('proj-1', trigger.id, { lastStatus: 'success', lastRunAt: 123 });
    expect(result.updated).toBe(true);
    expect(result.trigger.state.lastStatus).toBe('success');
    expect(result.trigger.state.lastRunAt).toBe(123);
    expect(result.trigger.secret).toBe(webhookInput.secret);
  });

  it('reports a missing trigger on state update', async () => {
    const result = await store.updateTriggerState('proj-1', 'nope', { lastStatus: 'error' });
    expect(result.updated).toBe(false);
    expect(result.trigger).toBeNull();
  });
});

describe('automation store workflows', () => {
  it('creates, lists, updates, and deletes a workflow', async () => {
    const { workflow, created } = await store.upsertWorkflow('proj-1', workflowInput);
    expect(created).toBe(true);
    expect(workflow.steps).toHaveLength(2);

    const updated = await store.upsertWorkflow('proj-1', {
      ...workflowInput,
      id: workflow.id,
      enabled: false,
      steps: [workflowInput.steps[0]],
    });
    expect(updated.workflow.enabled).toBe(false);
    expect(updated.workflow.steps).toHaveLength(1);

    const removed = await store.deleteWorkflow('proj-1', workflow.id);
    expect(removed.deleted).toBe(true);
    expect(await store.listWorkflows('proj-1')).toHaveLength(0);
  });

  it('updates workflow state and preserves steps', async () => {
    const { workflow } = await store.upsertWorkflow('proj-1', workflowInput);
    const result = await store.updateWorkflowState('proj-1', workflow.id, {
      lastStatus: 'error',
      lastError: 'boom',
      attempt: 2,
    });
    expect(result.workflow.state.lastError).toBe('boom');
    expect(result.workflow.state.attempt).toBe(2);
    expect(result.workflow.steps).toHaveLength(2);
  });

  it('rejects a workflow with no steps', async () => {
    await expect(store.upsertWorkflow('proj-1', { name: 'X', steps: [] })).rejects.toThrow('non-empty array');
  });
});

describe('automation store policy', () => {
  it('creates a policy with revision 1 and bumps on write', async () => {
    const first = await store.writePolicy({ rules: [{ name: 'Allow', action: 'accept', toolPattern: 'bash' }] });
    expect(first.revision).toBe(1);
    expect(first.rules).toHaveLength(1);

    const second = await store.writePolicy({ rules: [] });
    expect(second.revision).toBe(2);
    expect(second.rules).toHaveLength(0);

    const read = await store.readPolicy();
    expect(read.revision).toBe(2);
    expect(read.rules).toHaveLength(0);
  });

  it('returns an empty policy when nothing is stored', async () => {
    const policy = await store.readPolicy();
    expect(policy).toEqual({ rules: [], revision: 0 });
  });

  it('drops malformed rules on read', async () => {
    await store.writePolicy({ rules: [{ name: 'Good', action: 'accept', toolPattern: 'bash' }, { bad: true }] });
    const policy = await store.readPolicy();
    expect(policy.rules).toHaveLength(1);
  });
});

describe('automation store audit log', () => {
  it('appends and lists audit entries newest first', async () => {
    await store.appendAudit('proj-1', { id: 'a1', kind: 'trigger', status: 'success', at: 1 });
    await store.appendAudit('proj-1', { id: 'a2', kind: 'workflow', status: 'error', at: 2, error: 'fail' });
    const entries = await store.listAudit('proj-1');
    expect(entries.map((entry) => entry.id)).toEqual(['a2', 'a1']);
  });

  it('returns an empty list when the file is missing', async () => {
    await expect(store.listAudit('proj-never')).resolves.toEqual([]);
  });

  it('respects the limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.appendAudit('proj-1', { id: `a${index}`, kind: 'trigger', status: 'success', at: index });
    }
    const entries = await store.listAudit('proj-1', { limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('a4');
  });

  it('skips corrupt lines', async () => {
    await store.appendAudit('proj-1', { id: 'a1', kind: 'trigger', status: 'success', at: 1 });
    const file = store.auditFile('proj-1');
    const fsp = await import('node:fs/promises');
    await fsp.appendFile(file, 'not-json\n', 'utf8');
    await store.appendAudit('proj-1', { id: 'a2', kind: 'trigger', status: 'success', at: 2 });
    const entries = await store.listAudit('proj-1');
    expect(entries.map((entry) => entry.id)).toEqual(['a2', 'a1']);
  });
});
