import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { selectBudgetViolations } from './useSubagentBudgetEnforcement';

function child(id: string): Session {
  const fixture = {
    id,
    slug: id,
    projectID: 'p',
    directory: '/p',
    title: id,
    version: '1',
    time: { created: 0, updated: 0 },
    parentID: 'root',
  };
  // SAFETY: violation selection only reads child session identity fields.
  return fixture as Session;
}

describe('selectBudgetViolations', () => {
  const children = [child('a'), child('b')];

  test('empty when no budget', () => {
    const costs = new Map([['a', 100]]);
    expect(selectBudgetViolations(children, costs, null, () => true)).toEqual([]);
  });

  test('aborts a busy child at or over budget', () => {
    const costs = new Map([['a', 2], ['b', 0.5]]);
    expect(selectBudgetViolations(children, costs, 2, () => true)).toEqual(['a']);
  });

  test('does not abort an idle child over budget', () => {
    const costs = new Map([['a', 5]]);
    expect(selectBudgetViolations(children, costs, 1, (id) => id !== 'a')).toEqual([]);
  });

  test('does not abort a busy child under budget', () => {
    const costs = new Map([['a', 1.9]]);
    expect(selectBudgetViolations(children, costs, 2, () => true)).toEqual([]);
  });

  test('treats a missing cost as zero', () => {
    expect(selectBudgetViolations(children, new Map(), 1, () => true)).toEqual([]);
  });
});
