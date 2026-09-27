import crypto from 'node:crypto';
import { AUTOMATION_EVENT_KINDS } from './schema.js';

const timingSafeEqualString = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

const asNonEmptyString = (value) => {
  if (!isStringValue(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Verify a webhook secret against one of the accepted header/body forms.
 * Comparison is constant-time; a mismatch is a plain `false`, never an error
 * that could distinguish "unknown trigger" from "wrong secret".
 */
export const verifyWebhookSecret = (trigger, { headers = {}, body = null } = {}) => {
  const expected = asNonEmptyString(trigger?.secret);
  if (!expected || trigger?.kind !== 'webhook') return false;
  const candidates = [
    asNonEmptyString(headers['x-webhook-secret']),
    asNonEmptyString(headers['x-novacode-secret']),
    asNonEmptyString(headers.authorization)?.replace(/^Bearer\s+/i, ''),
    asNonEmptyString(isObjectRecord(body) ? body.secret : null),
  ].filter(Boolean);
  return candidates.some((candidate) => timingSafeEqualString(candidate, expected));
};

/**
 * True when a trigger should fire for a given event kind: enabled, of kind
 * `event`, and subscribed to exactly this kind.
 */
export const triggerMatchesEvent = (trigger, eventKind) => {
  if (!trigger || trigger.enabled === false) return false;
  if (trigger.kind !== 'event') return false;
  if (!AUTOMATION_EVENT_KINDS.includes(eventKind)) return false;
  return trigger.eventKind === eventKind;
};

/**
 * Pick every enabled webhook trigger for a project that accepts this secret.
 * Returning an array keeps multi-trigger hooks possible without a second call.
 */
export const findMatchingWebhookTriggers = (triggers, { headers, body }) => {
  if (!Array.isArray(triggers)) return [];
  return triggers.filter((trigger) => {
    if (!trigger || trigger.enabled === false || trigger.kind !== 'webhook') return false;
    return verifyWebhookSecret(trigger, { headers, body });
  });
};

/**
 * Pick every enabled event trigger for a project subscribed to this kind.
 */
export const findMatchingEventTriggers = (triggers, eventKind) => {
  if (!Array.isArray(triggers)) return [];
  return triggers.filter((trigger) => triggerMatchesEvent(trigger, eventKind));
};

/**
 * Minimal event envelope shared by internal publishers (session finish,
 * scheduled-task failure) and the webhook HTTP adapter.
 */
export const buildAutomationEvent = (eventKind, properties = {}) => {
  const kind = AUTOMATION_EVENT_KINDS.includes(eventKind) ? eventKind : null;
  if (!kind) throw new Error(`unsupported automation event: ${eventKind}`);
  return {
    kind,
    at: Date.now(),
    properties: isObjectRecord(properties) ? properties : {},
  };
};
