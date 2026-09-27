import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizePolicyDocument,
  normalizeTrigger,
  normalizeWorkflow,
} from './schema.js';

const AUTOMATION_STORE_VERSION = 1;
const MAX_AUDIT_ENTRIES = 500;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';
const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';

const asNonEmptyString = (value) => {
  if (!isStringValue(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveDataDir = () => (
  process.env.NOVACODE_DATA_DIR
    ? path.resolve(process.env.NOVACODE_DATA_DIR)
    : path.join(os.homedir(), '.config', 'novacode')
);

const sanitizeProjectID = (projectID) => {
  const value = asNonEmptyString(projectID);
  if (!value) throw new Error('projectId is required');
  if (!PROJECT_ID_PATTERN.test(value)) throw new Error('projectId contains unsupported characters');
  return value;
};

const readJsonSafe = async (filePath) => {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  return isObjectRecord(parsed) ? parsed : {};
};

const writeJsonAtomic = async (filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fsp.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(temporaryPath, filePath);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Per-project automation definitions: triggers, workflows, and runtime state.
 * Stored beside the project config in the data dir so scheduled-task writes
 * and automation writes never share one lock domain.
 */
export const createAutomationStore = (options = {}) => {
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : resolveDataDir();
  const rootDir = path.join(dataDir, 'automation');
  const projectDir = (projectID) => path.join(rootDir, 'projects', sanitizeProjectID(projectID));
  const projectFile = (projectID) => path.join(projectDir(projectID), 'definitions.json');
  const policyFile = path.join(rootDir, 'policy.json');
  const auditDir = path.join(rootDir, 'audit');
  const auditFile = (projectID) => path.join(auditDir, `${sanitizeProjectID(projectID)}.jsonl`);

  const writeLocks = new Map();
  const withLock = async (key, mutate) => {
    const previous = writeLocks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);
    await previous;
    try {
      return await mutate();
    } finally {
      release();
      if (writeLocks.get(key) === chained) writeLocks.delete(key);
    }
  };

  const emptyDocument = () => ({
    version: AUTOMATION_STORE_VERSION,
    triggers: [],
    workflows: [],
  });

  const readDocument = async (projectID) => {
    const parsed = await readJsonSafe(projectFile(projectID));
    if (!parsed) return emptyDocument();
    const now = Date.now();
    const triggers = [];
    for (const entry of Array.isArray(parsed.triggers) ? parsed.triggers : []) {
      try {
        triggers.push(normalizeTrigger(entry, { now, existing: null, allowCreate: true, refreshUpdatedAt: false }));
      } catch {
        // A malformed trigger is skipped; it never blocks the rest.
      }
    }
    const workflows = [];
    for (const entry of Array.isArray(parsed.workflows) ? parsed.workflows : []) {
      try {
        workflows.push(normalizeWorkflow(entry, { now, existing: null, allowCreate: true }));
      } catch {
        // Same isolation rule as triggers.
      }
    }
    return {
      version: AUTOMATION_STORE_VERSION,
      triggers,
      workflows,
      rawTriggers: new Map(triggers.map((trigger) => [trigger.id, (Array.isArray(parsed.triggers) ? parsed.triggers : []).find((raw) => raw?.id === trigger.id) || trigger])),
      rawWorkflows: new Map(workflows.map((workflow) => [workflow.id, (Array.isArray(parsed.workflows) ? parsed.workflows : []).find((raw) => raw?.id === workflow.id) || workflow])),
    };
  };

  const writeDocument = async (projectID, document, { replacedTriggerIds = new Set(), replacedWorkflowIds = new Set() } = {}) => {
    const existing = await readJsonSafe(projectFile(projectID)) || emptyDocument();
    const triggers = (document.triggers || []).map((trigger) => (
      replacedTriggerIds.has(trigger.id) ? trigger : (existing.triggers?.find((raw) => raw?.id === trigger.id) || trigger)
    ));
    const workflows = (document.workflows || []).map((workflow) => (
      replacedWorkflowIds.has(workflow.id) ? workflow : (existing.workflows?.find((raw) => raw?.id === workflow.id) || workflow)
    ));
    await writeJsonAtomic(projectFile(projectID), {
      ...existing,
      version: AUTOMATION_STORE_VERSION,
      triggers,
      workflows,
    });
  };

  const listTriggers = async (projectID) => (await readDocument(projectID)).triggers;
  const listWorkflows = async (projectID) => (await readDocument(projectID)).workflows;

  const upsertTrigger = async (projectID, triggerInput) => withLock(sanitizeProjectID(projectID), async () => {
    const now = Date.now();
    const current = await readDocument(projectID);
    const incomingId = asNonEmptyString(triggerInput?.id);
    const existingIndex = incomingId ? current.triggers.findIndex((entry) => entry.id === incomingId) : -1;
    const existing = existingIndex >= 0 ? current.triggers[existingIndex] : null;
    const normalized = normalizeTrigger(triggerInput, { now, existing, allowCreate: true });
    const nextTriggers = current.triggers.slice();
    const created = !existing;
    if (existingIndex >= 0) nextTriggers[existingIndex] = normalized;
    else nextTriggers.push(normalized);
    await writeDocument(projectID, { ...current, triggers: nextTriggers }, { replacedTriggerIds: new Set([normalized.id]) });
    return { trigger: normalized, triggers: nextTriggers, created };
  });

  const deleteTrigger = async (projectID, triggerID) => withLock(sanitizeProjectID(projectID), async () => {
    const normalizedID = asNonEmptyString(triggerID);
    if (!normalizedID) throw new Error('triggerId is required');
    const current = await readDocument(projectID);
    const nextTriggers = current.triggers.filter((entry) => entry.id !== normalizedID);
    const deleted = nextTriggers.length !== current.triggers.length;
    if (deleted) {
      await writeDocument(projectID, { ...current, triggers: nextTriggers });
    }
    return { deleted, triggers: nextTriggers };
  });

  const upsertWorkflow = async (projectID, workflowInput) => withLock(sanitizeProjectID(projectID), async () => {
    const now = Date.now();
    const current = await readDocument(projectID);
    const incomingId = asNonEmptyString(workflowInput?.id);
    const existingIndex = incomingId ? current.workflows.findIndex((entry) => entry.id === incomingId) : -1;
    const existing = existingIndex >= 0 ? current.workflows[existingIndex] : null;
    const normalized = normalizeWorkflow(workflowInput, { now, existing, allowCreate: true });
    const nextWorkflows = current.workflows.slice();
    const created = !existing;
    if (existingIndex >= 0) nextWorkflows[existingIndex] = normalized;
    else nextWorkflows.push(normalized);
    await writeDocument(projectID, { ...current, workflows: nextWorkflows }, { replacedWorkflowIds: new Set([normalized.id]) });
    return { workflow: normalized, workflows: nextWorkflows, created };
  });

  const deleteWorkflow = async (projectID, workflowID) => withLock(sanitizeProjectID(projectID), async () => {
    const normalizedID = asNonEmptyString(workflowID);
    if (!normalizedID) throw new Error('workflowId is required');
    const current = await readDocument(projectID);
    const nextWorkflows = current.workflows.filter((entry) => entry.id !== normalizedID);
    const deleted = nextWorkflows.length !== current.workflows.length;
    if (deleted) {
      await writeDocument(projectID, { ...current, workflows: nextWorkflows });
    }
    return { deleted, workflows: nextWorkflows };
  });

  const updateWorkflowState = async (projectID, workflowID, statePatch) => withLock(sanitizeProjectID(projectID), async () => {
    const normalizedID = asNonEmptyString(workflowID);
    if (!normalizedID) throw new Error('workflowId is required');
    const current = await readDocument(projectID);
    const index = current.workflows.findIndex((entry) => entry.id === normalizedID);
    if (index === -1) return { workflow: null, workflows: current.workflows, updated: false };
    const existing = current.workflows[index];
    const patch = isObjectRecord(statePatch) ? statePatch : {};
    const nextWorkflow = {
      ...existing,
      state: {
        ...existing.state,
        ...patch,
        updatedAt: Date.now(),
      },
    };
    const nextWorkflows = current.workflows.slice();
    nextWorkflows[index] = nextWorkflow;
    await writeDocument(projectID, { ...current, workflows: nextWorkflows }, { replacedWorkflowIds: new Set([normalizedID]) });
    return { workflow: nextWorkflow, workflows: nextWorkflows, updated: true };
  });

  const updateTriggerState = async (projectID, triggerID, statePatch) => withLock(sanitizeProjectID(projectID), async () => {
    const normalizedID = asNonEmptyString(triggerID);
    if (!normalizedID) throw new Error('triggerId is required');
    const current = await readDocument(projectID);
    const index = current.triggers.findIndex((entry) => entry.id === normalizedID);
    if (index === -1) return { trigger: null, triggers: current.triggers, updated: false };
    const existing = current.triggers[index];
    const patch = isObjectRecord(statePatch) ? statePatch : {};
    const nextTrigger = {
      ...existing,
      state: {
        ...existing.state,
        ...patch,
        updatedAt: Date.now(),
      },
    };
    const nextTriggers = current.triggers.slice();
    nextTriggers[index] = nextTrigger;
    await writeDocument(projectID, { ...current, triggers: nextTriggers }, { replacedTriggerIds: new Set([normalizedID]) });
    return { trigger: nextTrigger, triggers: nextTriggers, updated: true };
  });

  const readPolicy = async () => {
    const parsed = await readJsonSafe(policyFile);
    return normalizePolicyDocument(parsed);
  };

  const writePolicy = async (input) => withLock('policy', async () => {
    const current = await readPolicy();
    const base = isObjectRecord(input) ? input : {};
    const next = normalizePolicyDocument({
      ...base,
      revision: current.revision + 1,
    });
    await writeJsonAtomic(policyFile, { version: AUTOMATION_STORE_VERSION, ...next });
    return next;
  });

  const appendAudit = async (projectID, entry) => {
    const safeProjectID = sanitizeProjectID(projectID);
    const line = `${JSON.stringify(entry)}\n`;
    await fsp.mkdir(auditDir, { recursive: true });
    await fsp.appendFile(auditFile(safeProjectID), line, 'utf8');
    return entry;
  };

  const listAudit = async (projectID, { limit = 100 } = {}) => {
    const safeProjectID = sanitizeProjectID(projectID);
    let raw;
    try {
      raw = await fsp.readFile(auditFile(safeProjectID), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A corrupt line is skipped; it never breaks the list.
      }
    }
    const capped = Math.max(1, Math.min(Number(limit) || MAX_AUDIT_ENTRIES, MAX_AUDIT_ENTRIES));
    return entries.slice(-capped).reverse();
  };

  const trimAudit = async (projectID) => withLock(`audit:${sanitizeProjectID(projectID)}`, async () => {
    const entries = [];
    let raw;
    try {
      raw = await fsp.readFile(auditFile(projectID), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // dropped
      }
    }
    if (entries.length <= MAX_AUDIT_ENTRIES) return 0;
    const kept = entries.slice(-MAX_AUDIT_ENTRIES);
    const temporaryPath = `${auditFile(projectID)}.tmp-${process.pid}`;
    await fsp.writeFile(temporaryPath, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    await fsp.rename(temporaryPath, auditFile(projectID));
    return entries.length - kept.length;
  });

  return {
    dataDir,
    rootDir,
    listTriggers,
    listWorkflows,
    upsertTrigger,
    deleteTrigger,
    upsertWorkflow,
    deleteWorkflow,
    updateWorkflowState,
    updateTriggerState,
    readPolicy,
    writePolicy,
    appendAudit,
    listAudit,
    trimAudit,
    projectFile,
    auditFile,
  };
};

// Sync helper for tests that need to seed a file without going through the API.
export const seedAutomationFile = (filePath, document) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(document, null, 2), 'utf8');
};
