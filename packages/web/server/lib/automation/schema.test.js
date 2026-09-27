import { describe, expect, it } from 'vitest';
import {
  evaluatePolicyRules,
  normalizeAuditEntry,
  normalizePolicyDocument,
  normalizePolicyRule,
  normalizeTrigger,
  normalizeWorkflow,
} from './schema.js';

const webhookTrigger = {
  name: 'Deploy hook',
  kind: 'webhook',
  secret: 'a'.repeat(20),
  targetTaskId: 'task-1',
};

const eventTrigger = {
  name: 'On finish',
  kind: 'event',
  eventKind: 'session.finished',
  targetWorkflowId: 'wf-1',
};

const promptStep = {
  name: 'Review',
  kind: 'prompt',
  prompt: 'Review the change',
  providerID: 'openai',
  modelID: 'gpt-5',
  waitForIdle: true,
  timeoutMs: 60_000,
};

const shellStep = {
  name: 'Test',
  kind: 'shell',
  command: 'npm test',
  onFail: 'retry',
};

describe('normalizeTrigger', () => {
  it('creates a webhook trigger with a secret and id', () => {
    const trigger = normalizeTrigger(webhookTrigger, { now: 1000 });
    expect(trigger.id).toMatch(/^trg_/);
    expect(trigger.kind).toBe('webhook');
    expect(trigger.secret).toBe('a'.repeat(20));
    expect(trigger.enabled).toBe(true);
    expect(trigger.targetTaskId).toBe('task-1');
  });

  it('rejects a webhook trigger without a secret', () => {
    expect(() => normalizeTrigger({ ...webhookTrigger, secret: undefined })).toThrow('webhook trigger requires a secret');
  });

  it('rejects a secret that is too short', () => {
    expect(() => normalizeTrigger({ ...webhookTrigger, secret: 'short' })).toThrow('secret must be from');
  });

  it('keeps the existing secret when none is provided on update', () => {
    const existing = normalizeTrigger(webhookTrigger, { now: 1000 });
    const updated = normalizeTrigger({ ...webhookTrigger, id: existing.id, secret: undefined }, { existing });
    expect(updated.secret).toBe(existing.secret);
  });

  it('creates an event trigger for a known event kind', () => {
    const trigger = normalizeTrigger(eventTrigger, { now: 2000 });
    expect(trigger.eventKind).toBe('session.finished');
    expect(trigger.targetWorkflowId).toBe('wf-1');
  });

  it('rejects an unknown event kind', () => {
    expect(() => normalizeTrigger({ ...eventTrigger, eventKind: 'nope' })).toThrow('trigger.eventKind must be one of');
  });

  it('requires a target task or workflow', () => {
    expect(() => normalizeTrigger({ ...webhookTrigger, targetTaskId: undefined })).toThrow('targetTaskId or targetWorkflowId');
  });

  it('rejects changing the id on update', () => {
    const existing = normalizeTrigger(webhookTrigger, { now: 1000 });
    expect(() => normalizeTrigger({ ...webhookTrigger, id: 'other' }, { existing })).toThrow('trigger.id is immutable');
  });

  it('rejects an unknown kind', () => {
    expect(() => normalizeTrigger({ ...webhookTrigger, kind: 'cron' })).toThrow('trigger.kind must be one of');
  });
});

describe('normalizeWorkflow', () => {
  it('creates a workflow with ordered unique steps', () => {
    const workflow = normalizeWorkflow({
      name: 'CI fix',
      steps: [promptStep, shellStep],
      budget: { maxTokens: 50_000, maxAttempts: 3 },
      retry: { maxRetries: 2, backoffMs: 1000 },
    }, { now: 3000 });
    expect(workflow.id).toMatch(/^wf_/);
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0].waitForIdle).toBe(true);
    expect(workflow.steps[1].onFail).toBe('retry');
    expect(workflow.budget).toEqual({ maxTokens: 50_000, maxAttempts: 3 });
    expect(workflow.retry).toEqual({ maxRetries: 2, backoffMs: 1000 });
  });

  it('defaults waitForIdle to false and onFail to stop', () => {
    const workflow = normalizeWorkflow({
      name: 'Simple',
      steps: [{ name: 'A', kind: 'prompt', prompt: 'hi', providerID: 'p', modelID: 'm' }],
    });
    expect(workflow.steps[0].waitForIdle).toBe(false);
    expect(workflow.steps[0].onFail).toBe('stop');
  });

  it('rejects an empty step list', () => {
    expect(() => normalizeWorkflow({ name: 'X', steps: [] })).toThrow('non-empty array');
  });

  it('rejects more than the step cap', () => {
    const steps = Array.from({ length: 21 }, (_, index) => ({
      ...promptStep,
      name: `S${index}`,
    }));
    expect(() => normalizeWorkflow({ name: 'X', steps })).toThrow('at most 20 steps');
  });

  it('rejects duplicate step ids', () => {
    expect(() => normalizeWorkflow({
      name: 'X',
      steps: [{ ...promptStep, id: 'same' }, { ...promptStep, id: 'same', name: 'B' }],
    })).toThrow('unique');
  });

  it('rejects a prompt step without a model', () => {
    expect(() => normalizeWorkflow({
      name: 'X',
      steps: [{ name: 'A', kind: 'prompt', prompt: 'hi' }],
    })).toThrow('providerID and modelID');
  });

  it('rejects a shell step without a command', () => {
    expect(() => normalizeWorkflow({
      name: 'X',
      steps: [{ name: 'A', kind: 'shell' }],
    })).toThrow('command is required');
  });

  it('rejects an unknown onFail action', () => {
    expect(() => normalizeWorkflow({
      name: 'X',
      steps: [{ ...promptStep, onFail: 'explode' }],
    })).toThrow('onFail must be one of');
  });

  it('clamps retry maxRetries to 10', () => {
    const workflow = normalizeWorkflow({
      name: 'X',
      steps: [promptStep],
      retry: { maxRetries: 99 },
    });
    expect(workflow.retry.maxRetries).toBe(10);
  });

  it('drops a budget with no usable fields', () => {
    const workflow = normalizeWorkflow({
      name: 'X',
      steps: [promptStep],
      budget: { maxTokens: -1 },
    });
    expect(workflow.budget).toBeUndefined();
  });
});

describe('normalizePolicyRule / normalizePolicyDocument', () => {
  it('creates a rule with tool and content patterns', () => {
    const rule = normalizePolicyRule({
      name: 'Allow tests',
      action: 'accept',
      toolPattern: 'bash',
      contentPattern: 'npm test*',
    });
    expect(rule.id).toMatch(/^rule_/);
    expect(rule.action).toBe('accept');
    expect(rule.enabled).toBe(true);
  });

  it('requires at least one pattern', () => {
    expect(() => normalizePolicyRule({ name: 'X', action: 'accept' })).toThrow('toolPattern or contentPattern');
  });

  it('rejects an unknown action', () => {
    expect(() => normalizePolicyRule({ name: 'X', action: 'maybe', toolPattern: 'bash' })).toThrow('action must be one of');
  });

  it('drops malformed rules from the document without blocking valid ones', () => {
    const doc = normalizePolicyDocument({
      rules: [
        { name: 'Good', action: 'accept', toolPattern: 'bash' },
        { name: 'Bad' },
        null,
        { name: 'Also good', action: 'deny', contentPattern: 'rm -rf*' },
      ],
      revision: 2,
    });
    expect(doc.rules).toHaveLength(2);
    expect(doc.revision).toBe(2);
  });

  it('deduplicates by id', () => {
    const doc = normalizePolicyDocument({
      rules: [
        { id: 'a', name: 'One', action: 'accept', toolPattern: 'bash' },
        { id: 'a', name: 'Two', action: 'deny', toolPattern: 'bash' },
      ],
    });
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0].name).toBe('One');
  });
});

describe('evaluatePolicyRules', () => {
  const rules = [
    { id: 'r1', name: 'tests', action: 'accept', enabled: true, toolPattern: 'bash', contentPattern: 'npm test*' },
    { id: 'r2', name: 'danger', action: 'deny', enabled: true, contentPattern: '*rm -rf*' },
    { id: 'r3', name: 'files', action: 'hold', enabled: false, toolPattern: 'edit' },
  ];

  it('returns the first matching enabled rule', () => {
    expect(evaluatePolicyRules(rules, { permission: 'bash', command: 'npm test run' }))
      .toEqual({ action: 'accept', ruleId: 'r1', ruleName: 'tests' });
  });

  it('matches content-only patterns', () => {
    expect(evaluatePolicyRules(rules, { permission: 'bash', command: 'sudo rm -rf /' }))
      .toEqual({ action: 'deny', ruleId: 'r2', ruleName: 'danger' });
  });

  it('skips disabled rules', () => {
    expect(evaluatePolicyRules(rules, { permission: 'edit', path: 'src/a.ts' })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(evaluatePolicyRules(rules, { permission: 'webfetch', command: 'https://example.com' })).toBeNull();
  });

  it('returns null for empty rules or malformed permission', () => {
    expect(evaluatePolicyRules([], { permission: 'bash' })).toBeNull();
    expect(evaluatePolicyRules(rules, null)).toBeNull();
  });

  it('treats a bad pattern as non-matching instead of throwing', () => {
    const bad = [{ id: 'b', name: 'bad', action: 'deny', enabled: true, toolPattern: '[[' }];
    expect(evaluatePolicyRules(bad, { permission: 'bash' })).toBeNull();
  });
});

describe('normalizeAuditEntry', () => {
  it('fills id and timestamp defaults', () => {
    const entry = normalizeAuditEntry({ kind: 'trigger', status: 'success' }, { now: 4000 });
    expect(entry.id).toMatch(/^aud_/);
    expect(entry.at).toBe(4000);
  });

  it('requires kind and status', () => {
    expect(() => normalizeAuditEntry({ status: 'ok' })).toThrow('kind is required');
    expect(() => normalizeAuditEntry({ kind: 'trigger' })).toThrow('status is required');
  });

  it('clamps error length', () => {
    const entry = normalizeAuditEntry({ kind: 'workflow', status: 'error', error: 'x'.repeat(5000) });
    expect(entry.error.length).toBeLessThanOrEqual(2000);
  });
});
