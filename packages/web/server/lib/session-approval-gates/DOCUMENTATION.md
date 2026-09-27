# Session Approval Gates

## Purpose

Session-scoped approval gates force tool permissions belonging to a gated session — and its lineage — to stay on screen for the user, even when permission auto-accept would otherwise reply.

## Policy

`sessionApprovalGates.sessions` contains explicit per-session boolean policies (`true` = gated). Inheritance uses the nearest explicit session value, same as `permission-auto-accept`. A child `false` overrides a parent `true`.

Unknown lineage and failed policy loads fail closed for the gate check: the session is treated as ungated. A child spawned before an ancestor's gate is registered may miss that gate on its first action (spawn race); this is accepted product behavior.

## Runtime

`createSessionApprovalGatesRuntime` loads and serializes policy writes, caches session lineage from the global event hub, and exposes:

- `isSessionGated(sessionId, directory)` — nearest explicit ancestor value.
- `evaluatePermission(permission, directory)` — returns `{ action: 'hold', kind: 'approval_gate' }` when gated, otherwise `null`.

Gates are composed **first** in the auto-accept `evaluatePermission` chain in `server/index.js`, ahead of automation and routing, so a gate short-circuits both.

## Routes

- `GET /api/session-approval-gates`
- `PUT /api/session-approval-gates/sessions/:sessionId` — body `{ gated: boolean }`

These are normal authenticated Nova Code runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/sessionGateStore.ts` is a projection of server policy and does not persist an independent policy. The server broadcasts `novacode:session-approval-gates.updated` on every write; the shared UI hydrates on connect and applies that event. VS Code without the Nova Code server does not expose gate routes; the composer control is web/server-runtime only.

## Tests

`runtime.test.js` covers restart persistence, nearest explicit inheritance, gate hold vs pass-through, lineage lookup, and route validation.
