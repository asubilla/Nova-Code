import { describe, expect, it, vi } from 'vitest';
import { createApprovalJournal, createPolicyEngine } from './policy.js';

const acceptRule = {
  id: 'r1',
  name: 'accept tests',
  action: 'accept',
  enabled: true,
  toolPattern: 'bash',
  contentPattern: 'npm test*',
};

const denyRule = {
  id: 'r2',
  name: 'deny rm',
  action: 'deny',
  enabled: true,
  contentPattern: '*rm -rf*',
};

const makeStore = (rules) => ({
  readPolicy: vi.fn(async () => ({ rules, revision: 1 })),
  writePolicy: vi.fn(async (input) => ({ ...input, revision: 2 })),
});

describe('createPolicyEngine', () => {
  it('accepts a matching permission', async () => {
    const engine = createPolicyEngine({ store: makeStore([acceptRule]) });
    const verdict = await engine.evaluate({ permission: 'bash', command: 'npm test' });
    expect(verdict).toEqual({ action: 'accept', ruleId: 'r1', ruleName: 'accept tests' });
  });

  it('denies a matching permission', async () => {
    const engine = createPolicyEngine({ store: makeStore([denyRule]) });
    const verdict = await engine.evaluate({ permission: 'bash', command: 'sudo rm -rf /' });
    expect(verdict?.action).toBe('deny');
  });

  it('returns null when nothing matches', async () => {
    const engine = createPolicyEngine({ store: makeStore([acceptRule]) });
    expect(await engine.evaluate({ permission: 'edit', path: 'src/a.ts' })).toBeNull();
  });

  it('caches the loaded policy', async () => {
    const store = makeStore([acceptRule]);
    const engine = createPolicyEngine({ store });
    await engine.evaluate({ permission: 'bash', command: 'x' });
    await engine.evaluate({ permission: 'bash', command: 'y' });
    expect(store.readPolicy).toHaveBeenCalledTimes(1);
  });

  it('reloads after save', async () => {
    const store = makeStore([]);
    const engine = createPolicyEngine({ store });
    await engine.evaluate({ permission: 'bash', command: 'x' });
    await engine.save({ rules: [acceptRule] });
    expect(await engine.evaluate({ permission: 'bash', command: 'npm test' }))
      .toMatchObject({ action: 'accept' });
    expect(store.writePolicy).toHaveBeenCalledWith({ rules: [acceptRule] });
  });

  it('maps accept to non-hold for auto-accept', async () => {
    const engine = createPolicyEngine({ store: makeStore([acceptRule]) });
    const verdict = await engine.evaluateForAutoAccept({ permission: 'bash', command: 'npm test' });
    expect(verdict).toMatchObject({ action: 'accept', source: 'automation-policy', ruleId: 'r1' });
  });

  it('maps deny to hold so auto-accept does not reply', async () => {
    const engine = createPolicyEngine({ store: makeStore([denyRule]) });
    const verdict = await engine.evaluateForAutoAccept({ permission: 'bash', command: 'rm -rf /' });
    expect(verdict).toMatchObject({ action: 'hold', denied: true, source: 'automation-policy' });
  });

  it('maps hold to hold', async () => {
    const holdRule = { id: 'h1', name: 'hold', action: 'hold', enabled: true, toolPattern: 'edit' };
    const engine = createPolicyEngine({ store: makeStore([holdRule]) });
    const verdict = await engine.evaluateForAutoAccept({ permission: 'edit', path: 'a.ts' });
    expect(verdict).toMatchObject({ action: 'hold', source: 'automation-policy' });
  });

  it('calls onDecision with the verdict', async () => {
    const onDecision = vi.fn();
    const engine = createPolicyEngine({ store: makeStore([acceptRule]), onDecision });
    await engine.evaluateForAutoAccept({ permission: 'bash', command: 'npm test' });
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({
      action: 'accept',
      ruleId: 'r1',
      permission: expect.objectContaining({ permission: 'bash' }),
    }));
  });

  it('composes with an outer evaluator, preferring its own verdict', async () => {
    const outer = vi.fn(async () => ({ action: 'hold', source: 'outer' }));
    const engine = createPolicyEngine({ store: makeStore([acceptRule]) });
    const composed = engine.composeWithOuter(outer);
    const verdict = await composed({ permission: 'bash', command: 'npm test' }, '/repo');
    expect(verdict).toMatchObject({ action: 'accept', source: 'automation-policy' });
    expect(outer).not.toHaveBeenCalled();
  });

  it('falls through to the outer evaluator on no match', async () => {
    const outer = vi.fn(async () => ({ action: 'hold', source: 'outer' }));
    const engine = createPolicyEngine({ store: makeStore([acceptRule]) });
    const composed = engine.composeWithOuter(outer);
    const verdict = await composed({ permission: 'webfetch', path: 'x' }, '/repo');
    expect(verdict).toEqual({ action: 'hold', source: 'outer' });
    expect(outer).toHaveBeenCalled();
  });

  it('throws on save without a store', async () => {
    const engine = createPolicyEngine({});
    await expect(engine.save({ rules: [] })).rejects.toThrow('unavailable');
    expect(await engine.evaluate({ permission: 'bash' })).toBeNull();
  });
});

describe('createApprovalJournal', () => {
  it('records pending approvals newest first', () => {
    const journal = createApprovalJournal();
    journal.record({ permissionId: 'p1', sessionId: 's1', action: 'hold' });
    journal.record({ permissionId: 'p2', sessionId: 's2', action: 'hold' });
    const pending = journal.list();
    expect(pending.map((entry) => entry.permissionId)).toEqual(['p2', 'p1']);
    expect(pending[0].status).toBe('pending');
  });

  it('resolves approvals and filters by status', () => {
    const journal = createApprovalJournal();
    journal.record({ permissionId: 'p1', action: 'hold' });
    journal.record({ permissionId: 'p2', action: 'hold' });
    const resolved = journal.resolve('p1', 'approved');
    expect(resolved.status).toBe('approved');
    expect(journal.list()).toHaveLength(1);
    expect(journal.list({ status: 'all' })).toHaveLength(2);
    expect(journal.list({ status: 'approved' })).toHaveLength(1);
  });

  it('returns null when resolving an unknown id', () => {
    const journal = createApprovalJournal();
    expect(journal.resolve('missing', 'approved')).toBeNull();
  });

  it('drops the oldest entry past the limit', () => {
    const journal = createApprovalJournal({ limit: 2 });
    journal.record({ permissionId: 'p1', action: 'hold' });
    journal.record({ permissionId: 'p2', action: 'hold' });
    journal.record({ permissionId: 'p3', action: 'hold' });
    const ids = journal.list().map((entry) => entry.permissionId);
    expect(ids).toEqual(['p3', 'p2']);
  });

  it('ignores records without a permissionId', () => {
    const journal = createApprovalJournal();
    expect(journal.record({ action: 'hold' })).toBeNull();
    expect(journal.list()).toHaveLength(0);
  });

  it('removes and clears entries', () => {
    const journal = createApprovalJournal();
    journal.record({ permissionId: 'p1', action: 'hold' });
    expect(journal.remove('p1')).toBe(true);
    journal.record({ permissionId: 'p2', action: 'hold' });
    journal.clear();
    expect(journal.list()).toHaveLength(0);
  });
});
