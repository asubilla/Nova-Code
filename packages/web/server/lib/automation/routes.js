/**
 * HTTP surface for the automation module.
 *
 * Route order matters: the webhook endpoint is registered before the generic
 * OpenCode proxy so `/api/webhooks/...` is never swallowed by the proxy.
 * All handlers map thrown errors to status codes via `error.statusCode`.
 *
 * Body parsing is attached per write route: the server has no global JSON
 * parser, and `/api/automation` + `/api/webhooks` are not on the core-routes
 * allowlist, so a write route without `express.json()` would see `req.body`
 * as `undefined`. (`/api/projects/...` is allowlisted; the per-route parser
 * there is redundant but keeps this module self-contained for tests.)
 */
import express from 'express';

const parseJsonBody = express.json({ limit: '2mb' });

const isObjectRecord = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';
const isStringValue = (value) => Object.prototype.toString.call(value) === '[object String]';

export const registerAutomationRoutes = (app, dependencies = {}) => {
  const {
    runtime = null,
    service = null,
    getNovaCodeEventClients = null,
    writeSseEvent = null,
  } = dependencies;

  const svc = service ?? runtime?.service ?? null;
  const rt = runtime ?? svc?.runtime ?? null;

  if (!svc) {
    // Without a service there is nothing to serve; leave routes unregistered
    // rather than mounting handlers that always 500.
    return;
  }

  const handle = (res, error) => {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (status >= 500) {
      console.error('[Automation] request failed:', error);
    }
    res.status(status).json({ error: error?.message || 'Automation request failed' });
  };

  // --- definitions ---------------------------------------------------------

  app.get('/api/projects/:projectId/automation', async (req, res) => {
    try {
      return res.json(await svc.list(req.params.projectId));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.put('/api/projects/:projectId/automation/triggers', parseJsonBody, async (req, res) => {
    try {
      const trigger = req.body?.trigger;
      if (!isObjectRecord(trigger)) {
        return res.status(400).json({ error: 'trigger payload is required' });
      }
      return res.json(await svc.upsertTrigger(req.params.projectId, trigger));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.delete('/api/projects/:projectId/automation/triggers/:triggerId', async (req, res) => {
    try {
      return res.json(await svc.removeTrigger(req.params.projectId, req.params.triggerId));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.put('/api/projects/:projectId/automation/workflows', parseJsonBody, async (req, res) => {
    try {
      const workflow = req.body?.workflow;
      if (!isObjectRecord(workflow)) {
        return res.status(400).json({ error: 'workflow payload is required' });
      }
      return res.json(await svc.upsertWorkflow(req.params.projectId, workflow));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.delete('/api/projects/:projectId/automation/workflows/:workflowId', async (req, res) => {
    try {
      return res.json(await svc.removeWorkflow(req.params.projectId, req.params.workflowId));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/projects/:projectId/automation/workflows/:workflowId/run', parseJsonBody, async (req, res) => {
    try {
      const report = await svc.runWorkflow(req.params.projectId, req.params.workflowId);
      return res.json({ ok: true, ...report });
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/projects/:projectId/automation/triggers/:triggerId/fire', parseJsonBody, async (req, res) => {
    try {
      return res.json(await svc.fireTrigger(req.params.projectId, req.params.triggerId, req.body ?? {}));
    } catch (error) {
      return handle(res, error);
    }
  });

  // --- policy --------------------------------------------------------------

  app.get('/api/automation/policies', async (_req, res) => {
    try {
      return res.json(await svc.getPolicy());
    } catch (error) {
      return handle(res, error);
    }
  });

  app.put('/api/automation/policies', parseJsonBody, async (req, res) => {
    try {
      return res.json(await svc.putPolicy(req.body ?? {}));
    } catch (error) {
      return handle(res, error);
    }
  });

  // --- approval inbox ------------------------------------------------------

  app.get('/api/automation/approvals', async (req, res) => {
    try {
      const rawStatus = req.query?.status;
      const status = isStringValue(rawStatus) ? rawStatus : 'pending';
      return res.json(await svc.listApprovals({ status }));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/automation/approvals/:permissionId/resolve', parseJsonBody, async (req, res) => {
    try {
      const decision = req.body?.decision;
      return res.json(await svc.resolveApproval(req.params.permissionId, decision));
    } catch (error) {
      return handle(res, error);
    }
  });

  app.post('/api/automation/approvals/batch', parseJsonBody, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.permissionIds) ? req.body.permissionIds : [];
      const decision = req.body?.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        return res.status(400).json({ error: 'decision must be approved or denied' });
      }
      const results = [];
      for (const id of ids) {
        try {
          results.push(await svc.resolveApproval(id, decision));
        } catch (error) {
          results.push({ ok: false, permissionId: id, error: error?.message });
        }
      }
      return res.json({ results });
    } catch (error) {
      return handle(res, error);
    }
  });

  // --- audit ---------------------------------------------------------------

  app.get('/api/projects/:projectId/automation/audit', async (req, res) => {
    try {
      const limit = Number(req.query?.limit) || 100;
      return res.json(await svc.listAudit(req.params.projectId, { limit }));
    } catch (error) {
      return handle(res, error);
    }
  });

  // --- webhook ingress -----------------------------------------------------
  // Registered last among automation routes but before any catch-all proxy.
  // Auth is verified inside the runtime so a wrong secret is a 401, not a 404
  // that would distinguish unknown projects.

  app.post('/api/webhooks/:projectId/:triggerId', parseJsonBody, async (req, res) => {
    try {
      if (!rt) return res.status(503).json({ error: 'automation runtime is unavailable' });
      const headers = req.headers ?? {};
      const body = req.body ?? null;
      const triggers = await rt.listTriggers(req.params.projectId);
      const trigger = triggers.find((entry) => entry.id === req.params.triggerId);
      if (!trigger) return res.status(404).json({ error: 'trigger not found' });
      if (trigger.enabled === false) return res.status(409).json({ error: 'trigger is disabled' });
      if (!rt.verifyWebhookSecret(trigger, { headers, body })) {
        return res.status(401).json({ error: 'invalid webhook secret' });
      }
      const result = await rt.fireTrigger(req.params.projectId, trigger.id, {
        reason: 'webhook',
        payload: isObjectRecord(body) ? body : null,
        verified: true,
      });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });

  // Convenience alias: POST /api/webhooks/:projectId fires every trigger whose
  // secret matches, for operators who want one endpoint per project.
  app.post('/api/webhooks/:projectId', parseJsonBody, async (req, res) => {
    try {
      if (!rt) return res.status(503).json({ error: 'automation runtime is unavailable' });
      const result = await rt.handleWebhook(req.params.projectId, {
        headers: req.headers ?? {},
        body: req.body ?? null,
      });
      return res.json(result);
    } catch (error) {
      return handle(res, error);
    }
  });

  // --- status --------------------------------------------------------------

  app.get('/api/novacode/automation/status', async (_req, res) => {
    try {
      if (!rt) return res.json({ available: false });
      return res.json({ available: true, ...rt.getStatus() });
    } catch (error) {
      return handle(res, error);
    }
  });

  void getNovaCodeEventClients;
  void writeSseEvent;
};

export default registerAutomationRoutes;
