import { describe, expect, it } from 'vitest';
import {
  buildAutomationEvent,
  findMatchingEventTriggers,
  findMatchingWebhookTriggers,
  triggerMatchesEvent,
  verifyWebhookSecret,
} from './triggers.js';

const secret = 'topsecret-secret-value';

const webhookTrigger = {
  id: 'wh1',
  kind: 'webhook',
  enabled: true,
  secret,
  targetTaskId: 'task-1',
};

const eventTrigger = {
  id: 'ev1',
  kind: 'event',
  enabled: true,
  eventKind: 'session.finished',
  targetWorkflowId: 'wf-1',
};

describe('verifyWebhookSecret', () => {
  it('accepts the x-webhook-secret header', () => {
    expect(verifyWebhookSecret(webhookTrigger, { headers: { 'x-webhook-secret': secret } })).toBe(true);
  });

  it('accepts the x-novacode-secret header', () => {
    expect(verifyWebhookSecret(webhookTrigger, { headers: { 'x-novacode-secret': secret } })).toBe(true);
  });

  it('accepts an Authorization bearer token', () => {
    expect(verifyWebhookSecret(webhookTrigger, { headers: { authorization: `Bearer ${secret}` } })).toBe(true);
  });

  it('accepts a secret in the JSON body', () => {
    expect(verifyWebhookSecret(webhookTrigger, { body: { secret } })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyWebhookSecret(webhookTrigger, { headers: { 'x-webhook-secret': 'wrong' } })).toBe(false);
  });

  it('rejects a missing secret', () => {
    expect(verifyWebhookSecret(webhookTrigger, { headers: {} })).toBe(false);
  });

  it('rejects non-webhook triggers even with a matching secret', () => {
    expect(verifyWebhookSecret({ ...eventTrigger, secret }, { headers: { 'x-webhook-secret': secret } })).toBe(false);
  });

  it('rejects when the trigger has no secret stored', () => {
    expect(verifyWebhookSecret({ id: 'x', kind: 'webhook', enabled: true }, {
      headers: { 'x-webhook-secret': secret },
    })).toBe(false);
  });

  it('rejects empty secrets without throwing', () => {
    expect(verifyWebhookSecret({ id: 'x', kind: 'webhook', enabled: true, secret: '' }, {
      headers: { 'x-webhook-secret': '' },
    })).toBe(false);
  });
});

describe('triggerMatchesEvent', () => {
  it('matches an enabled event trigger to its kind', () => {
    expect(triggerMatchesEvent(eventTrigger, 'session.finished')).toBe(true);
  });

  it('rejects a different event kind', () => {
    expect(triggerMatchesEvent(eventTrigger, 'session.failed')).toBe(false);
  });

  it('rejects a disabled trigger', () => {
    expect(triggerMatchesEvent({ ...eventTrigger, enabled: false }, 'session.finished')).toBe(false);
  });

  it('rejects a webhook trigger', () => {
    expect(triggerMatchesEvent(webhookTrigger, 'session.finished')).toBe(false);
  });

  it('rejects an unknown event kind', () => {
    expect(triggerMatchesEvent(eventTrigger, 'something.else')).toBe(false);
  });
});

describe('findMatchingWebhookTriggers', () => {
  it('returns only triggers whose secret matches', () => {
    const other = { ...webhookTrigger, id: 'wh2', secret: 'other-secret-value' };
    const matches = findMatchingWebhookTriggers([webhookTrigger, other], {
      headers: { 'x-webhook-secret': secret },
    });
    expect(matches.map((entry) => entry.id)).toEqual(['wh1']);
  });

  it('skips disabled triggers', () => {
    const matches = findMatchingWebhookTriggers([{ ...webhookTrigger, enabled: false }], {
      headers: { 'x-webhook-secret': secret },
    });
    expect(matches).toHaveLength(0);
  });

  it('returns an empty array for non-array input', () => {
    expect(findMatchingWebhookTriggers(null, { headers: {} })).toEqual([]);
  });
});

describe('findMatchingEventTriggers', () => {
  it('returns only matching enabled event triggers', () => {
    const other = { ...eventTrigger, id: 'ev2', eventKind: 'scheduled.task.failed' };
    const matches = findMatchingEventTriggers([eventTrigger, other], 'session.finished');
    expect(matches.map((entry) => entry.id)).toEqual(['ev1']);
  });

  it('returns an empty array for non-array input', () => {
    expect(findMatchingEventTriggers(undefined, 'session.finished')).toEqual([]);
  });
});

describe('buildAutomationEvent', () => {
  it('builds a normalized envelope', () => {
    const event = buildAutomationEvent('session.failed', { sessionId: 's1' });
    expect(event.kind).toBe('session.failed');
    expect(event.properties.sessionId).toBe('s1');
    expect(Number.isFinite(event.at)).toBe(true);
  });

  it('throws for an unsupported kind', () => {
    expect(() => buildAutomationEvent('nope')).toThrow('unsupported automation event');
  });
});
