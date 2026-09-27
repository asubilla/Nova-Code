import { describe, expect, it, vi } from 'vitest';
import {
  buildEscalation,
  clampErrorMessage,
  computeRetryDelay,
  createBudgetTracker,
  runWithRetries,
} from './retries.js';

describe('createBudgetTracker', () => {
  it('allows unlimited use when no budget is configured', () => {
    const tracker = createBudgetTracker(null);
    expect(tracker.maxTokens).toBeNull();
    expect(tracker.consume(1_000_000).allowed).toBe(true);
    expect(tracker.breached).toBe(false);
  });

  it('breaches when tokens exceed maxTokens', () => {
    const tracker = createBudgetTracker({ maxTokens: 100 });
    expect(tracker.consume(50).allowed).toBe(true);
    expect(tracker.remaining()).toBe(50);
    const result = tracker.consume(60);
    expect(result.allowed).toBe(false);
    expect(tracker.breached).toBe(true);
    expect(tracker.reason).toMatch(/token budget exceeded \(110\/100\)/);
  });

  it('breaches when attempts reach maxAttempts', () => {
    const tracker = createBudgetTracker({ maxAttempts: 2 });
    expect(tracker.beginAttempt()).toBe(true);
    expect(tracker.beginAttempt()).toBe(true);
    expect(tracker.beginAttempt()).toBe(false);
    expect(tracker.reason).toMatch(/attempt budget exhausted \(2\/2\)/);
  });

  it('keeps the first breach reason stable', () => {
    const tracker = createBudgetTracker({ maxTokens: 10, maxAttempts: 1 }, { now: () => 42 });
    tracker.consume(20);
    const first = tracker.reason;
    tracker.consume(20);
    expect(tracker.reason).toBe(first);
    expect(tracker.breachedAt).toBe(42);
  });

  it('restores starting used and attempt values', () => {
    const tracker = createBudgetTracker({ maxTokens: 100, maxAttempts: 5 }, {
      startingUsed: 40,
      startingAttempt: 3,
    });
    expect(tracker.used).toBe(40);
    expect(tracker.attempt).toBe(3);
    expect(tracker.consume(10).remaining).toBe(50);
  });

  it('snapshots current state', () => {
    const tracker = createBudgetTracker({ maxTokens: 100 });
    tracker.consume(30);
    expect(tracker.snapshot()).toMatchObject({ used: 30, maxTokens: 100, breached: false, attempt: 0 });
  });
});

describe('computeRetryDelay', () => {
  it('doubles the base delay per retry', () => {
    expect(computeRetryDelay({ retryIndex: 1, maxRetries: 3, backoffMs: 100 })).toBe(100);
    expect(computeRetryDelay({ retryIndex: 2, maxRetries: 3, backoffMs: 100 })).toBe(200);
    expect(computeRetryDelay({ retryIndex: 3, maxRetries: 3, backoffMs: 100 })).toBe(400);
  });

  it('caps at five minutes', () => {
    expect(computeRetryDelay({ retryIndex: 10, maxRetries: 10, backoffMs: 60_000 })).toBe(300_000);
  });

  it('returns null when retries are exhausted', () => {
    expect(computeRetryDelay({ retryIndex: 4, maxRetries: 3, backoffMs: 100 })).toBeNull();
    expect(computeRetryDelay({ retryIndex: 1, maxRetries: 0, backoffMs: 100 })).toBeNull();
    expect(computeRetryDelay({ retryIndex: 0, maxRetries: 3, backoffMs: 100 })).toBeNull();
  });

  it('defaults to 1000ms base when backoffMs is invalid', () => {
    expect(computeRetryDelay({ retryIndex: 1, maxRetries: 1, backoffMs: -5 })).toBe(1000);
  });
});

describe('runWithRetries', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await runWithRetries(fn, { maxRetries: 3 });
    expect(result).toMatchObject({ ok: true, status: 'success', value: 'ok', retriesUsed: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success within the budget', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'done';
    });
    const sleep = vi.fn(async () => {});
    const result = await runWithRetries(fn, { maxRetries: 3, backoffMs: 10, sleep });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('done');
    expect(result.retriesUsed).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns a structured failure when all attempts fail', async () => {
    const fn = vi.fn(async () => { throw new Error('always'); });
    const result = await runWithRetries(fn, { maxRetries: 2, backoffMs: 1, sleep: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toBe('always');
    expect(result.attempts).toHaveLength(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when the budget is already breached', async () => {
    const budget = createBudgetTracker({ maxTokens: 10 });
    budget.consume(20);
    const fn = vi.fn(async () => 'never');
    const result = await runWithRetries(fn, { maxRetries: 5, budget });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('budget_exhausted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('consumes budget attempts and stops when maxAttempts is reached', async () => {
    const budget = createBudgetTracker({ maxAttempts: 2 });
    const fn = vi.fn(async () => { throw new Error('fail'); });
    const result = await runWithRetries(fn, { maxRetries: 10, budget, sleep: async () => {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('budget_exhausted');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('invokes onRetry with delay and error', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async (index) => {
      if (index === 0) throw new Error('boom');
      return 'ok';
    });
    await runWithRetries(fn, { maxRetries: 1, backoffMs: 5, onRetry, sleep: async () => {} });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delay: 5, error: 'boom' }));
  });
});

describe('buildEscalation', () => {
  it('builds an escalation payload', () => {
    const payload = buildEscalation({
      kind: 'workflow',
      name: 'CI fix',
      projectId: 'p1',
      error: new Error('step failed'),
      attempt: 3,
      maxAttempts: 3,
      sessionId: 's1',
    });
    expect(payload.type).toBe('novacode:automation.escalated');
    expect(payload.properties).toMatchObject({
      kind: 'workflow',
      name: 'CI fix',
      projectId: 'p1',
      error: 'step failed',
      attempt: 3,
      maxAttempts: 3,
      sessionId: 's1',
    });
    expect(Number.isFinite(payload.properties.at)).toBe(true);
  });

  it('returns null without an error', () => {
    expect(buildEscalation({ kind: 'workflow', name: 'x', error: null })).toBeNull();
  });
});

describe('clampErrorMessage', () => {
  it('clamps long messages', () => {
    expect(clampErrorMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(2000);
  });

  it('handles non-error values', () => {
    expect(clampErrorMessage(undefined)).toBe('Unknown error');
    expect(clampErrorMessage('  ')).toBe('Unknown error');
  });
});
