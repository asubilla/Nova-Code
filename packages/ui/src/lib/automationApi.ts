import { runtimeFetch } from './runtime-fetch';

export type AutomationTriggerKind = 'webhook' | 'event';
export type AutomationEventKind = 'session.finished' | 'session.failed' | 'scheduled.task.failed';
export type AutomationPolicyAction = 'accept' | 'deny' | 'hold';
export type AutomationOnFail = 'stop' | 'continue' | 'retry';
export type AutomationStatus = 'idle' | 'running' | 'success' | 'error';

export type AutomationTriggerState = {
  createdAt: number;
  updatedAt: number;
  lastStatus?: AutomationStatus;
  lastRunAt?: number;
  lastError?: string;
  lastSessionId?: string;
  attempt?: number;
  budgetUsed?: number;
};

export type AutomationTrigger = {
  id: string;
  name: string;
  kind: AutomationTriggerKind;
  enabled: boolean;
  targetTaskId?: string;
  targetWorkflowId?: string;
  eventKind?: AutomationEventKind;
  state: AutomationTriggerState;
  /** Present only on write payloads for webhook triggers; never returned by list. */
  secret?: string;
};

export type AutomationWorkflowStep = {
  id: string;
  name: string;
  kind: 'prompt' | 'shell';
  onFail: AutomationOnFail;
  prompt?: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  waitForIdle?: boolean;
  timeoutMs?: number;
  command?: string;
};

export type AutomationWorkflow = {
  id: string;
  name: string;
  enabled: boolean;
  steps: AutomationWorkflowStep[];
  budget?: { maxTokens?: number; maxAttempts?: number };
  retry?: { maxRetries?: number; backoffMs?: number };
  state: AutomationTriggerState;
};

export type AutomationPolicyRule = {
  id: string;
  name: string;
  action: AutomationPolicyAction;
  enabled: boolean;
  toolPattern?: string;
  contentPattern?: string;
};

export type AutomationPolicy = {
  rules: AutomationPolicyRule[];
  revision: number;
};

export type AutomationApproval = {
  id: string;
  permissionId: string;
  sessionId: string | null;
  directory: string | null;
  action: string;
  ruleId?: string;
  ruleName?: string;
  title?: string | null;
  at: number;
  status: 'pending' | 'approved' | 'denied';
  resolvedAt?: number;
};

export type AutomationAuditDetail = {
  reason?: string;
  durationMs?: number;
  steps?: number;
  status?: string;
  payloadKeys?: string[];
};

export type AutomationAuditEntry = {
  id: string;
  kind: string;
  status: string;
  at: number;
  projectId?: string;
  triggerId?: string;
  workflowId?: string;
  taskId?: string;
  sessionId?: string;
  stepId?: string;
  error?: string;
  detail?: AutomationAuditDetail;
};

export type AutomationDefinitions = {
  triggers: AutomationTrigger[];
  workflows: AutomationWorkflow[];
};

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    // SAFETY: our error routes answer with a JSON object that may carry `error?: string`.
    const parsed = (await response.json()) as { error?: string } | null;
    const message = parsed?.error;
    if (message && message.trim().length > 0) return message;
  } catch {
    return fallback;
  }
  return fallback;
};

const ensureProjectID = (projectID: string): string => {
  const trimmed = projectID.trim();
  if (!trimmed) throw new Error('projectId is required');
  return trimmed;
};

const jsonRequest = async <T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> => {
  const response = await runtimeFetch(url, init);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, fallback));
  }
  // SAFETY: response.ok; callers declare the expected shape for this route.
  return response.json() as Promise<T>;
};

export const fetchAutomationDefinitions = async (projectID: string): Promise<AutomationDefinitions> => {
  const safe = ensureProjectID(projectID);
  const parsed = await jsonRequest<{ triggers?: unknown; workflows?: unknown }>(
    `/api/projects/${encodeURIComponent(safe)}/automation`,
    undefined,
    'Failed to load automations',
  );
  // SAFETY: server returns a normalized AutomationTrigger list.
  const triggers = Array.isArray(parsed.triggers) ? (parsed.triggers as AutomationTrigger[]) : [];
  // SAFETY: server returns a normalized AutomationWorkflow list.
  const workflows = Array.isArray(parsed.workflows) ? (parsed.workflows as AutomationWorkflow[]) : [];
  return { triggers, workflows };
};

export const upsertAutomationTrigger = async (
  projectID: string,
  trigger: Partial<AutomationTrigger> & { name: string; kind: AutomationTriggerKind },
): Promise<{ trigger: AutomationTrigger; triggers: AutomationTrigger[]; created: boolean }> => {
  const safe = ensureProjectID(projectID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/triggers`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ trigger }),
    },
    'Failed to save automation trigger',
  );
};

export const deleteAutomationTrigger = async (projectID: string, triggerID: string): Promise<{ deleted: boolean; triggers: AutomationTrigger[] }> => {
  const safe = ensureProjectID(projectID);
  const safeId = ensureProjectID(triggerID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/triggers/${encodeURIComponent(safeId)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
    'Failed to delete automation trigger',
  );
};

export const upsertAutomationWorkflow = async (
  projectID: string,
  workflow: Partial<AutomationWorkflow> & { name: string; steps: AutomationWorkflowStep[] },
): Promise<{ workflow: AutomationWorkflow; workflows: AutomationWorkflow[]; created: boolean }> => {
  const safe = ensureProjectID(projectID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/workflows`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ workflow }),
    },
    'Failed to save automation workflow',
  );
};

export const deleteAutomationWorkflow = async (projectID: string, workflowID: string): Promise<{ deleted: boolean; workflows: AutomationWorkflow[] }> => {
  const safe = ensureProjectID(projectID);
  const safeId = ensureProjectID(workflowID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/workflows/${encodeURIComponent(safeId)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
    'Failed to delete automation workflow',
  );
};

export type AutomationRunReport = {
  ok?: boolean;
  running?: boolean;
  status?: string;
  error?: string;
  triggerId?: string;
  deferred?: boolean;
  targetTaskId?: string;
  sessionId?: string;
};

export const runAutomationWorkflow = async (projectID: string, workflowID: string): Promise<AutomationRunReport> => {
  const safe = ensureProjectID(projectID);
  const safeId = ensureProjectID(workflowID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/workflows/${encodeURIComponent(safeId)}/run`,
    { method: 'POST', headers: { accept: 'application/json' } },
    'Failed to run automation workflow',
  );
};

export type AutomationFireResult = {
  ok?: boolean;
  running?: boolean;
  triggerId?: string;
  status?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
};

export const fireAutomationTrigger = async (
  projectID: string,
  triggerID: string,
  payload: Record<string, string | number | boolean | null> = {},
): Promise<AutomationFireResult> => {
  const safe = ensureProjectID(projectID);
  const safeId = ensureProjectID(triggerID);
  return jsonRequest(
    `/api/projects/${encodeURIComponent(safe)}/automation/triggers/${encodeURIComponent(safeId)}/fire`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ payload }),
    },
    'Failed to fire automation trigger',
  );
};

export const fetchAutomationPolicy = async (): Promise<AutomationPolicy> => {
  return jsonRequest('/api/automation/policies', undefined, 'Failed to load automation policy');
};

export const saveAutomationPolicy = async (policy: { rules: AutomationPolicyRule[] }): Promise<AutomationPolicy> => {
  return jsonRequest('/api/automation/policies', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(policy),
  }, 'Failed to save automation policy');
};

export const fetchAutomationApprovals = async (status: 'pending' | 'approved' | 'denied' | 'all' = 'pending'): Promise<AutomationApproval[]> => {
  const parsed = await jsonRequest<{ approvals?: unknown }>(
    `/api/automation/approvals?status=${encodeURIComponent(status)}`,
    undefined,
    'Failed to load approvals',
  );
  // SAFETY: server returns normalized AutomationApproval items.
  return Array.isArray(parsed.approvals) ? (parsed.approvals as AutomationApproval[]) : [];
};

export const resolveAutomationApproval = async (
  permissionID: string,
  decision: 'approved' | 'denied',
): Promise<{ approval: AutomationApproval }> => {
  const safe = ensureProjectID(permissionID);
  return jsonRequest(
    `/api/automation/approvals/${encodeURIComponent(safe)}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ decision }),
    },
    'Failed to resolve approval',
  );
};

export const resolveAutomationApprovalsBatch = async (
  permissionIDs: string[],
  decision: 'approved' | 'denied',
): Promise<{ results: Array<{ approval?: AutomationApproval; ok?: boolean; permissionId?: string; error?: string }> }> => {
  return jsonRequest('/api/automation/approvals/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ permissionIds: permissionIDs, decision }),
  }, 'Failed to resolve approvals');
};

export const fetchAutomationAudit = async (projectID: string, limit = 100): Promise<AutomationAuditEntry[]> => {
  const safe = ensureProjectID(projectID);
  const parsed = await jsonRequest<{ entries?: unknown }>(
    `/api/projects/${encodeURIComponent(safe)}/automation/audit?limit=${encodeURIComponent(String(limit))}`,
    undefined,
    'Failed to load automation audit',
  );
  // SAFETY: server returns normalized AutomationAuditEntry items.
  return Array.isArray(parsed.entries) ? (parsed.entries as AutomationAuditEntry[]) : [];
};

export type AutomationStatusPayload = {
  available: boolean;
  runningWorkflows?: number;
  pendingApprovals?: number;
  policyRevision?: number;
};

export const fetchAutomationStatus = async (): Promise<AutomationStatusPayload> => {
  const response = await runtimeFetch('/api/novacode/automation/status');
  if (!response.ok) return { available: false };
  // SAFETY: status endpoint always returns { available: boolean } (+ optional counts).
  return response.json() as Promise<AutomationStatusPayload>;
};
