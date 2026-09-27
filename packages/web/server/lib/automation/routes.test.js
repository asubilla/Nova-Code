import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import supertest from 'supertest';
import { createAutomationRuntime } from './runtime.js';
import { createAutomationStore } from './store.js';
import { registerAutomationRoutes } from './routes.js';

let tempRoot;
let store;
let runtime;
let app;

const workflowShell = {
  id: 'wf-ok',
  name: 'OK pipeline',
  enabled: true,
  steps: [{ id: 'a', name: 'Echo', kind: 'shell', command: 'echo routes-ok', onFail: 'stop' }],
};

const webhookTriggerInput = {
  id: 'trg-hook',
  name: 'Hook',
  kind: 'webhook',
  secret: 's'.repeat(24),
  targetWorkflowId: 'wf-ok',
};

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-automation-rt-'));
  store = createAutomationStore({ dataDir: tempRoot });
  runtime = createAutomationRuntime({
    store,
    listProjects: async () => [{ id: 'proj-1', path: tempRoot }],
    buildOpenCodeUrl: (suffix) => `http://127.0.0.1:4096${suffix}`,
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    sleep: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  // Deliberately NO app.use(express.json()): production has no global parser
  // for these paths, so the suite must prove each write route brings its own.
  app = express();
  registerAutomationRoutes(app, { runtime, service: runtime.service });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('automation routes definitions', () => {
  it('GET automation returns empty collections', async () => {
    const response = await supertest(app).get('/api/projects/proj-1/automation');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ triggers: [], workflows: [] });
  });

  it('PUT trigger creates without echoing the secret', async () => {
    const response = await supertest(app)
      .put('/api/projects/proj-1/automation/triggers')
      .send({ trigger: webhookTriggerInput });
    expect(response.status).toBe(200);
    expect(response.body.trigger.secret).toBeUndefined();
    expect(response.body.created).toBe(true);
  });

  it('PUT trigger without payload returns 400', async () => {
    const response = await supertest(app)
      .put('/api/projects/proj-1/automation/triggers')
      .send({});
    expect(response.status).toBe(400);
  });

  it('DELETE trigger removes it', async () => {
    await supertest(app).put('/api/projects/proj-1/automation/triggers').send({ trigger: webhookTriggerInput });
    const response = await supertest(app).delete('/api/projects/proj-1/automation/triggers/trg-hook');
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
  });

  it('PUT workflow creates and validates steps', async () => {
    const response = await supertest(app)
      .put('/api/projects/proj-1/automation/workflows')
      .send({ workflow: workflowShell });
    expect(response.status).toBe(200);
    expect(response.body.workflow.steps).toHaveLength(1);

    const bad = await supertest(app)
      .put('/api/projects/proj-1/automation/workflows')
      .send({ workflow: { name: 'X', steps: [] } });
    expect(bad.status).toBe(400);
  });

  it('POST workflow run executes', async () => {
    await supertest(app).put('/api/projects/proj-1/automation/workflows').send({ workflow: workflowShell });
    const response = await supertest(app).post('/api/projects/proj-1/automation/workflows/wf-ok/run');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('POST workflow run returns 404 for unknown id', async () => {
    const response = await supertest(app).post('/api/projects/proj-1/automation/workflows/missing/run');
    expect(response.status).toBe(404);
  });

  it('POST trigger fire runs it', async () => {
    await supertest(app).put('/api/projects/proj-1/automation/workflows').send({ workflow: workflowShell });
    await supertest(app).put('/api/projects/proj-1/automation/triggers').send({ trigger: webhookTriggerInput });
    const response = await supertest(app).post('/api/projects/proj-1/automation/triggers/trg-hook/fire').send({});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

describe('automation routes policy and approvals', () => {
  it('GET policies returns the document', async () => {
    const response = await supertest(app).get('/api/automation/policies');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ rules: [], revision: 0 });
  });

  it('PUT policies replaces and bumps revision', async () => {
    const response = await supertest(app).put('/api/automation/policies').send({
      rules: [{ name: 'Allow', action: 'accept', toolPattern: 'bash' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.revision).toBe(1);
    expect(response.body.rules).toHaveLength(1);
  });

  it('GET approvals is empty initially', async () => {
    const response = await supertest(app).get('/api/automation/approvals');
    expect(response.status).toBe(200);
    expect(response.body.approvals).toEqual([]);
  });

  it('resolve approval returns 404 when unknown', async () => {
    const response = await supertest(app)
      .post('/api/automation/approvals/missing/resolve')
      .send({ decision: 'approved' });
    expect(response.status).toBe(404);
  });

  it('batch resolve validates the decision', async () => {
    const bad = await supertest(app).post('/api/automation/approvals/batch').send({ permissionIds: [], decision: 'maybe' });
    expect(bad.status).toBe(400);

    runtime.approvalJournal.record({ permissionId: 'p1', action: 'hold' });
    const good = await supertest(app).post('/api/automation/approvals/batch').send({
      permissionIds: ['p1', 'missing'],
      decision: 'approved',
    });
    expect(good.status).toBe(200);
    expect(good.body.results).toHaveLength(2);
    expect(good.body.results[0].approval.status).toBe('approved');
    expect(good.body.results[1].ok).toBe(false);
  });
});

describe('automation routes audit and status', () => {
  it('GET audit returns entries newest first', async () => {
    await store.appendAudit('proj-1', { id: 'a1', kind: 'trigger', status: 'success', at: 1 });
    await store.appendAudit('proj-1', { id: 'a2', kind: 'workflow', status: 'error', at: 2 });
    const response = await supertest(app).get('/api/projects/proj-1/automation/audit?limit=10');
    expect(response.status).toBe(200);
    expect(response.body.entries.map((entry) => entry.id)).toEqual(['a2', 'a1']);
  });

  it('GET status reports the runtime', async () => {
    const response = await supertest(app).get('/api/novacode/automation/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: true, runningWorkflows: 0 });
  });
});

describe('automation routes webhooks', () => {
  beforeEach(async () => {
    await supertest(app).put('/api/projects/proj-1/automation/workflows').send({ workflow: workflowShell });
    await supertest(app).put('/api/projects/proj-1/automation/triggers').send({ trigger: webhookTriggerInput });
  });

  it('rejects a wrong secret with 401', async () => {
    const response = await supertest(app)
      .post('/api/webhooks/proj-1/trg-hook')
      .set('x-webhook-secret', 'wrong-secret-value')
      .send({ hello: 'world' });
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch('invalid webhook secret');
  });

  it('accepts a valid secret and fires the workflow', async () => {
    const response = await supertest(app)
      .post('/api/webhooks/proj-1/trg-hook')
      .set('x-webhook-secret', 's'.repeat(24))
      .send({ hello: 'world' });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.triggerId).toBe('trg-hook');
  });

  it('returns 404 for an unknown trigger id', async () => {
    const response = await supertest(app)
      .post('/api/webhooks/proj-1/nope')
      .set('x-webhook-secret', 's'.repeat(24))
      .send({});
    expect(response.status).toBe(404);
  });

  it('project-level webhook fires matching triggers', async () => {
    const response = await supertest(app)
      .post('/api/webhooks/proj-1')
      .set('x-webhook-secret', 's'.repeat(24))
      .send({ hello: 'world' });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.results).toHaveLength(1);
  });

  it('project-level webhook rejects a wrong secret with 401', async () => {
    const response = await supertest(app)
      .post('/api/webhooks/proj-1')
      .set('x-webhook-secret', 'nope')
      .send({});
    expect(response.status).toBe(401);
  });
});
