import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionMetadataRecord } from './sessionReviewMetadata';
import {
  getSubagentBudget,
  parseCostBudget,
  withSubagentBudget,
} from './subagentBudget';

function makeSession(metadata?: SessionMetadataRecord): Session {
  const base = {
    id: 's1',
    slug: 's1',
    projectID: 'p',
    directory: '/p',
    title: 't',
    version: '1',
    time: { created: 0, updated: 0 },
  };
  const fixture = metadata === undefined ? base : { ...base, metadata };
  // SAFETY: budget code only reads session.metadata.novacode.subagentBudget.
  return fixture as Session;
}

describe('parseCostBudget', () => {
  test('accepts positive finite numbers', () => {
    expect(parseCostBudget(1.5)).toBe(1.5);
    expect(parseCostBudget(0.01)).toBe(0.01);
  });

  test('rejects zero, negative, and non-finite numbers', () => {
    expect(parseCostBudget(0)).toBeNull();
    expect(parseCostBudget(-1)).toBeNull();
    expect(parseCostBudget(Number.NaN)).toBeNull();
    expect(parseCostBudget(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('getSubagentBudget', () => {
  test('returns null without metadata', () => {
    expect(getSubagentBudget(null)).toBeNull();
    expect(getSubagentBudget(makeSession())).toBeNull();
    expect(getSubagentBudget(makeSession({ novacode: {} }))).toBeNull();
  });

  test('parses a valid budget', () => {
    expect(getSubagentBudget(makeSession({
      novacode: { subagentBudget: { costBudget: 2.5 } },
    }))).toEqual({ costBudget: 2.5 });
  });

  test('rejects invalid payloads', () => {
    expect(getSubagentBudget(makeSession({
      novacode: { subagentBudget: { costBudget: 0 } },
    }))).toBeNull();
    expect(getSubagentBudget(makeSession({
      novacode: { subagentBudget: { costBudget: 'x' } },
    }))).toBeNull();
    expect(getSubagentBudget(makeSession({
      novacode: { subagentBudget: 'nope' },
    }))).toBeNull();
  });
});

describe('withSubagentBudget', () => {
  test('sets the budget under novacode', () => {
    const next = withSubagentBudget({}, 3);
    expect(next.novacode).toEqual({ subagentBudget: { costBudget: 3 } });
  });

  test('preserves sibling novacode fields', () => {
    const next = withSubagentBudget({ novacode: { kind: 'review' } }, 3);
    expect(next.novacode).toEqual({
      kind: 'review',
      subagentBudget: { costBudget: 3 },
    });
  });

  test('clearing removes only the budget key', () => {
    const set = withSubagentBudget({ novacode: { kind: 'review' } }, 3);
    const cleared = withSubagentBudget(set, null);
    expect(cleared.novacode).toEqual({ kind: 'review' });
  });

  test('clearing the last novacode key drops the namespace', () => {
    const cleared = withSubagentBudget(withSubagentBudget({}, 3), null);
    expect(cleared.novacode).toBeUndefined();
  });

  test('is a no-op shape-wise when clearing an absent budget', () => {
    const cleared = withSubagentBudget({}, null);
    expect(cleared.novacode).toBeUndefined();
  });
});
