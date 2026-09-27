# Automation

Event triggers, multi-step workflows, auto-approve policy, budget guards,
retries with escalation, an approval inbox, and an append-only audit log for
Nova Code.

## Ownership

- **Module**: `packages/web/server/lib/automation/`
- **Persistence**: `NOVACODE_DATA_DIR/automation/`
  - `projects/<projectId>/definitions.json` — triggers + workflows
  - `policy.json` — auto-approve rules (global)
  - `audit/<projectId>.jsonl` — append-only audit entries (capped at 500)
- **Routes**: registered from `feature-routes-runtime.js` alongside the other
  feature registrars; webhook routes are declared before the generic OpenCode
  proxy so they are never swallowed.

## Invariants

1. Secrets never leave the server: list/serialize paths strip `secret`.
2. One failed entity never blocks another: malformed triggers/workflows are
   skipped on read; corrupt audit lines are skipped; batch approval continues
   past individual failures.
3. Policy engine composes ahead of the routing safety net: automation policy
   first, outer `evaluatePermission` second, first non-null verdict wins.
4. Budget breaches never throw mid-step: the tracker records the reason and
   the runner stops cleanly with `budget_exhausted`.
5. Webhook auth is constant-time and never distinguishes unknown project from
   wrong secret to unauthenticated callers (401 vs 404 is only about trigger
   existence after secret check inside the handler).
6. Audit writes are best-effort: an audit failure logs a warning and never
   fails the run that produced it.
7. Shell-only workflows never require OpenCode: the `ready()` gate — and the
   `baseUrl()` / `authHeaders()` values that also throw without a live port —
   run only when the workflow has a prompt step (prompt steps wait again
   inside `createSession` → `getClient`), so a missing OpenCode port fails
   prompt steps, not the whole shell pipeline.

## Contracts

### Store (`createAutomationStore`)

- `listTriggers/listWorkflows(projectId)`
- `upsertTrigger/upsertWorkflow(projectId, input)` → `{ trigger|workflow, created }`
- `deleteTrigger/deleteWorkflow(projectId, id)` → `{ deleted, ... }`
- `updateTriggerState/updateWorkflowState(projectId, id, patch)`
- `readPolicy()/writePolicy(input)` — revision bumps on every write
- `appendAudit/listAudit/trimAudit(projectId, …)`

### Schema (`schema.js`)

- `normalizeTrigger`, `normalizeWorkflow`, `normalizePolicyRule`,
  `normalizePolicyDocument`, `normalizeAuditEntry`, `evaluatePolicyRules`
- Glob patterns: `*` and `?`, case-insensitive, anchored full match.
- Caps: `AUTOMATION_WORKFLOW_MAX_STEPS=20`, `AUTOMATION_POLICY_RULES_MAX=100`,
  secrets 16–256 chars, prompts ≤ 20 000 chars.

### Runtime (`createAutomationRuntime`)

- `runWorkflow(projectId, workflowId, { reason })` → run report
- `fireTrigger(projectId, triggerId, { reason, payload, verified })`
- `handleWebhook(projectId, { headers, body })` — multi-trigger, secret-checked
- `publishEvent(projectId, eventKind, properties)` — internal event fan-out
- `handlePermissionAsk(permission, directory)` — policy + approval journal
- `evaluatePermission(permission, directory)` — adapter for auto-accept hook
- `replyApproval(entry, decision)` — POST to OpenCode `/permission/:id/reply`
- `getStatus()`, `start()`, `stop()`

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:projectId/automation` | list triggers + workflows (no secrets) |
| PUT | `/api/projects/:projectId/automation/triggers` | upsert trigger |
| DELETE | `/api/projects/:projectId/automation/triggers/:triggerId` | delete trigger |
| PUT | `/api/projects/:projectId/automation/workflows` | upsert workflow |
| DELETE | `/api/projects/:projectId/automation/workflows/:workflowId` | delete workflow |
| POST | `/api/projects/:projectId/automation/workflows/:workflowId/run` | run workflow |
| POST | `/api/projects/:projectId/automation/triggers/:triggerId/fire` | fire trigger manually |
| GET | `/api/automation/policies` | read policy |
| PUT | `/api/automation/policies` | replace policy (revision bump) |
| GET | `/api/automation/approvals?status=` | approval inbox |
| POST | `/api/automation/approvals/:permissionId/resolve` | approve/deny one |
| POST | `/api/automation/approvals/batch` | approve/deny many |
| GET | `/api/projects/:projectId/automation/audit` | recent audit entries |
| POST | `/api/webhooks/:projectId/:triggerId` | authenticated webhook |
| POST | `/api/webhooks/:projectId` | project webhook (any matching secret) |
| GET | `/api/novacode/automation/status` | runtime status |

**Body parsing is attached per write route** (`express.json({ limit: '2mb' })`).
This server has no global JSON parser: `core-routes` parses only an allowlist
of `/api` prefixes, and `/api/automation` + `/api/webhooks` are not on it —
without a per-route parser those handlers see `req.body` as `undefined`.
(`/api/projects/...` is allowlisted; the per-route parser there is redundant
but keeps the module self-contained under tests, which mount a bare express
app with no global parser.)

### Workflow steps

Each step is `prompt` or `shell`, runs in array order, and carries its own
`onFail`: `stop` (default), `continue`, or `retry`. `retry` uses the workflow
`retry.maxRetries` / `retry.backoffMs` (exponential, capped 5 min). Optional
`budget: { maxTokens, maxAttempts }` stops the run with `budget_exhausted`
without throwing mid-step.

### Policy rules

```json
{
  "rules": [
    { "name": "Allow tests", "action": "accept", "toolPattern": "bash", "contentPattern": "npm test*" }
  ],
  "revision": 1
}
```

Actions: `accept` (auto-approve), `deny` (hold + mark denied), `hold` (leave
for user, journaled to the approval inbox). First matching enabled rule wins.

## Testing

Focused tests colocated as `*.test.js`, run with:

```bash
cd packages/web && npx vitest run server/lib/automation
```

Each feature area has its own test file: `schema`, `store`, `triggers`,
`workflows`, `retries`, `policy`, `service`, `runtime`, `routes`.
