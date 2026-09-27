import { AUTOMATION_LAST_ERROR_MAX_LENGTH } from './schema.js';

const wait = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); });

const clampError = (error) => {
  const raw = error instanceof Error ? (error.message || String(error)) : String(error ?? 'Unknown error');
  const trimmed = raw.trim() || 'Unknown error';
  return trimmed.length > AUTOMATION_LAST_ERROR_MAX_LENGTH
    ? trimmed.slice(0, AUTOMATION_LAST_ERROR_MAX_LENGTH)
    : trimmed;
};

/**
 * Budget guard for one automation run. Tracks token usage against an optional
 * `maxTokens` cap and attempt count against an optional `maxAttempts` cap.
 * A breach never throws mid-step; it records the reason so the runner can stop
 * cleanly and write an audit entry.
 */
export const createBudgetTracker = (budget, { startingUsed = 0, startingAttempt = 0, now = Date.now } = {}) => {
  const maxTokens = Number.isFinite(budget?.maxTokens) && budget.maxTokens > 0 ? Math.floor(budget.maxTokens) : null;
  const maxAttempts = Number.isFinite(budget?.maxAttempts) && budget.maxAttempts >= 1 ? Math.floor(budget.maxAttempts) : null;
  let used = Number.isFinite(startingUsed) && startingUsed >= 0 ? Math.floor(startingUsed) : 0;
  let attempt = Number.isFinite(startingAttempt) && startingAttempt >= 0 ? Math.floor(startingAttempt) : 0;
  let breachedReason = null;
  let breachedAt = null;

  const remaining = () => (maxTokens === null ? null : Math.max(0, maxTokens - used));

  const checkAttempt = () => {
    if (breachedReason !== null) return false;
    if (maxAttempts !== null && attempt >= maxAttempts) {
      breachedReason = `attempt budget exhausted (${attempt}/${maxAttempts})`;
      breachedAt = now();
      return false;
    }
    return true;
  };

  const consume = (tokens) => {
    const amount = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
    used += amount;
    if (maxTokens !== null && used > maxTokens) {
      if (breachedReason === null) {
        breachedReason = `token budget exceeded (${used}/${maxTokens})`;
        breachedAt = now();
      }
      return { allowed: false, used, remaining: 0, breached: true, reason: breachedReason };
    }
    return { allowed: true, used, remaining: remaining(), breached: breachedReason !== null };
  };

  const beginAttempt = () => {
    if (!checkAttempt()) return false;
    attempt += 1;
    if (maxAttempts !== null && attempt > maxAttempts) {
      attempt = maxAttempts;
      breachedReason = breachedReason ?? `attempt budget exhausted (${attempt}/${maxAttempts})`;
      breachedAt = breachedAt ?? now();
      return false;
    }
    if (maxAttempts !== null && attempt >= maxAttempts) {
      // Record the breach after granting this (the final allowed) attempt so
      // the next `beginAttempt` fails without an off-by-one.
      breachedReason = `attempt budget exhausted (${attempt}/${maxAttempts})`;
      breachedAt = now();
    }
    return true;
  };

  return {
    maxTokens,
    maxAttempts,
    get used() { return used; },
    get attempt() { return attempt; },
    get breached() { return breachedReason !== null; },
    get reason() { return breachedReason; },
    get breachedAt() { return breachedAt; },
    remaining,
    consume,
    beginAttempt,
    checkAttempt,
    snapshot: () => {
      const snap = {
        used,
        attempt,
        maxTokens,
        maxAttempts,
        breached: breachedReason !== null,
      };
      if (breachedReason) snap.reason = breachedReason;
      if (breachedAt !== null) snap.breachedAt = breachedAt;
      return snap;
    },
  };
};

/**
 * Decide whether another retry should run after a failure.
 * `maxRetries` is additional attempts after the first; `backoffMs` is the base
 * delay, doubled per retry (capped at 5 minutes).
 */
export const computeRetryDelay = ({ retryIndex, maxRetries, backoffMs }) => {
  if (!Number.isFinite(retryIndex) || retryIndex < 1) return null;
  if (!Number.isFinite(maxRetries) || maxRetries < 1) return null;
  if (retryIndex > maxRetries) return null;
  const base = Number.isFinite(backoffMs) && backoffMs >= 0 ? Math.floor(backoffMs) : 1000;
  const delay = base * (2 ** (retryIndex - 1));
  return Math.min(delay, 300_000);
};

/**
 * Run `fn` with configured retries. Each attempt gets a fresh budget attempt
 * check; when the budget is already breached the loop stops immediately.
 * Returns a structured result — it never rejects for ordinary failures.
 */
export const runWithRetries = async (fn, {
  maxRetries = 0,
  backoffMs = 1000,
  budget = null,
  onAttempt = null,
  onRetry = null,
  sleep = wait,
} = {}) => {
  const attempts = [];
  let lastError = null;
  let retryIndex = 0;

  // Always allow at least the first attempt even when maxRetries is 0.
  const totalAttempts = Math.max(1, Math.floor(maxRetries) + 1);

  for (let index = 0; index < totalAttempts; index += 1) {
    if (budget && budget.beginAttempt) {
      const allowed = budget.beginAttempt();
      if (!allowed) {
        return {
          ok: false,
          status: 'budget_exhausted',
          attempts,
          error: budget.reason || 'budget exhausted',
          retriesUsed: retryIndex,
        };
      }
    }

    try {
      const value = await fn(index);
      attempts.push({ index, ok: true, at: Date.now() });
      return { ok: true, status: 'success', value, attempts, retriesUsed: retryIndex };
    } catch (error) {
      lastError = error;
      attempts.push({ index, ok: false, at: Date.now(), error: clampError(error) });
      retryIndex = index + 1;
      const delay = computeRetryDelay({ retryIndex, maxRetries: Math.max(0, totalAttempts - 1), backoffMs });
      if (delay === null) break;
      onRetry?.({ attempt: index + 1, delay, error: clampError(error) });
      await sleep(delay);
    }
  }

  return {
    ok: false,
    status: 'error',
    attempts,
    error: clampError(lastError),
    retriesUsed: Math.max(0, retryIndex - 1),
  };
};

/**
 * Map a terminal failure into an escalation payload the notifications layer
 * understands. Returns null when escalation is not warranted (success, or
 * no configured receiver).
 */
export const buildEscalation = ({ kind, name, projectId, error, attempt, maxAttempts, sessionId = null }) => {
  if (!error) return null;
  const properties = {
    type: 'novacode:automation.escalated',
  };
  const payload = {
    kind,
    name: name || 'automation',
    error: clampError(error),
    at: Date.now(),
  };
  if (projectId) payload.projectId = projectId;
  if (Number.isFinite(attempt)) payload.attempt = attempt;
  if (Number.isFinite(maxAttempts)) payload.maxAttempts = maxAttempts;
  if (sessionId) payload.sessionId = sessionId;
  properties.properties = payload;
  return properties;
};

export const clampErrorMessage = clampError;
