import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  fetchAutomationApprovals,
  fetchAutomationAudit,
  fetchAutomationDefinitions,
  fetchAutomationPolicy,
  fireAutomationTrigger,
  resolveAutomationApproval,
  resolveAutomationApprovalsBatch,
  runAutomationWorkflow,
  saveAutomationPolicy,
  upsertAutomationTrigger,
  upsertAutomationWorkflow,
  deleteAutomationTrigger,
  deleteAutomationWorkflow,
  fetchAutomationStatus,
  type AutomationApproval,
  type AutomationAuditEntry,
  type AutomationEventKind,
  type AutomationPolicy,
  type AutomationPolicyAction,
  type AutomationPolicyRule,
  type AutomationTrigger,
  type AutomationWorkflow,
  type AutomationWorkflowStep,
} from '@/lib/automationApi';

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const EVENT_KINDS: AutomationEventKind[] = ['session.finished', 'session.failed', 'scheduled.task.failed'];

const emptyTrigger = (): AutomationTrigger => ({
  id: newId('trg'),
  name: '',
  kind: 'webhook',
  enabled: true,
  targetWorkflowId: '',
  eventKind: 'session.finished',
  state: { createdAt: Date.now(), updatedAt: Date.now() },
});

const emptyWorkflow = (): AutomationWorkflow => ({
  id: newId('wf'),
  name: '',
  enabled: true,
  steps: [],
  state: { createdAt: Date.now(), updatedAt: Date.now() },
});

const emptyStep = (): AutomationWorkflowStep => ({
  id: newId('step'),
  name: '',
  kind: 'shell',
  onFail: 'stop',
  command: '',
});

const emptyRule = (): AutomationPolicyRule => ({
  id: newId('rule'),
  name: '',
  action: 'accept',
  enabled: true,
  toolPattern: '*',
  contentPattern: '*',
});

export function AutomationPage() {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const settingsDirectory = useSettingsDirectory();

  const project = React.useMemo(() => {
    if (projects.length === 0) return null;
    return projects.find((entry) => entry.path === settingsDirectory) ?? projects[0] ?? null;
  }, [projects, settingsDirectory]);
  const projectID = project?.id ?? '';

  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<{ available: boolean; runningWorkflows?: number; pendingApprovals?: number; policyRevision?: number } | null>(null);
  const [triggers, setTriggers] = React.useState<AutomationTrigger[]>([]);
  const [workflows, setWorkflows] = React.useState<AutomationWorkflow[]>([]);
  const [policy, setPolicy] = React.useState<AutomationPolicy | null>(null);
  const [policyDraft, setPolicyDraft] = React.useState<AutomationPolicyRule[]>([]);
  const [approvals, setApprovals] = React.useState<AutomationApproval[]>([]);
  const [audit, setAudit] = React.useState<AutomationAuditEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [editingTrigger, setEditingTrigger] = React.useState<AutomationTrigger | null>(null);
  const [editingWorkflow, setEditingWorkflow] = React.useState<AutomationWorkflow | null>(null);
  const [expandedWorkflow, setExpandedWorkflow] = React.useState<string | null>(null);
  const [newSecret, setNewSecret] = React.useState('');

  const refreshStatus = React.useCallback(async () => {
    try {
      setStatus(await fetchAutomationStatus());
    } catch {
      setStatus({ available: false });
    }
  }, []);

  const refresh = React.useCallback(async () => {
    if (!projectID) {
      setTriggers([]);
      setWorkflows([]);
      setAudit([]);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setLoadError(null);
    try {
      const [defs, pol, appr, aud] = await Promise.all([
        fetchAutomationDefinitions(projectID),
        fetchAutomationPolicy(),
        fetchAutomationApprovals('pending'),
        fetchAutomationAudit(projectID, 50),
      ]);
      setTriggers(defs.triggers);
      setWorkflows(defs.workflows);
      setPolicy(pol);
      setPolicyDraft(pol.rules);
      setApprovals(appr);
      setAudit(aud);
      setLoaded(true);
      void refreshStatus();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoaded(true);
    }
  }, [projectID, refreshStatus]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const describeFailure = (error: Error | string): string => (
    error instanceof Error ? error.message : error
  );

  const failToast = React.useCallback((error: Error | string) => {
    toast.error(t('settings.automation.toast.failed', { error: describeFailure(error) }));
  }, [t]);

  const saveTrigger = async () => {
    if (!editingTrigger || !projectID) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      const payload = { ...editingTrigger };
      if (payload.kind === 'webhook' && newSecret.trim().length >= 16) {
        payload.secret = newSecret.trim();
      } else if (payload.kind === 'webhook' && !payload.id.startsWith('trg-')) {
        // keep server error for short secret on create
      } else {
        delete payload.secret;
      }
      if (!payload.name.trim()) throw new Error(t('settings.automation.triggers.name'));
      if (!payload.targetWorkflowId && !payload.targetTaskId) {
        throw new Error(t('settings.automation.triggers.targetWorkflow'));
      }
      if (payload.kind === 'webhook' && !payload.secret && !triggers.some((entry) => entry.id === payload.id)) {
        throw new Error(t('settings.automation.triggers.secretInfo'));
      }
      const result = await upsertAutomationTrigger(projectID, payload);
      setTriggers(result.triggers);
      setEditingTrigger(null);
      setNewSecret('');
      reportSettingsSaveState('saved');
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const removeTrigger = async (id: string) => {
    if (!projectID) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      const result = await deleteAutomationTrigger(projectID, id);
      setTriggers(result.triggers);
      reportSettingsSaveState('saved');
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const fire = async (id: string) => {
    if (!projectID) return;
    setBusy(true);
    try {
      await fireAutomationTrigger(projectID, id, {});
      toast.success(t('settings.automation.toast.triggerFired'));
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveWorkflow = async () => {
    if (!editingWorkflow || !projectID) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      if (!editingWorkflow.name.trim()) throw new Error(t('settings.automation.workflows.name'));
      if (editingWorkflow.steps.length === 0) throw new Error(t('settings.automation.workflows.steps'));
      const result = await upsertAutomationWorkflow(projectID, editingWorkflow);
      setWorkflows(result.workflows);
      setEditingWorkflow(null);
      reportSettingsSaveState('saved');
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const removeWorkflow = async (id: string) => {
    if (!projectID) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      const result = await deleteAutomationWorkflow(projectID, id);
      setWorkflows(result.workflows);
      reportSettingsSaveState('saved');
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const run = async (id: string) => {
    if (!projectID) return;
    setBusy(true);
    try {
      await runAutomationWorkflow(projectID, id);
      toast.success(t('settings.automation.toast.runStarted'));
      void refreshStatus();
      void refresh();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      const cleaned = policyDraft
        .filter((rule) => rule.name.trim().length > 0)
        .map((rule) => ({
          ...rule,
          toolPattern: rule.toolPattern?.trim() ? rule.toolPattern : undefined,
          contentPattern: rule.contentPattern?.trim() ? rule.contentPattern : undefined,
        }));
      const next = await saveAutomationPolicy({ rules: cleaned });
      setPolicy(next);
      setPolicyDraft(next.rules);
      reportSettingsSaveState('saved');
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const resolveOne = async (permissionId: string, decision: 'approved' | 'denied') => {
    setBusy(true);
    try {
      await resolveAutomationApproval(permissionId, decision);
      setApprovals((prev) => prev.filter((entry) => entry.permissionId !== permissionId));
      toast.success(t('settings.automation.toast.approvalResolved'));
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resolveAll = async (decision: 'approved' | 'denied') => {
    if (approvals.length === 0) return;
    setBusy(true);
    try {
      await resolveAutomationApprovalsBatch(approvals.map((entry) => entry.permissionId), decision);
      setApprovals([]);
      toast.success(t('settings.automation.toast.approvalResolved'));
      void refreshStatus();
    } catch (error) {
      failToast(error instanceof Error ? error : String(error));
    } finally {
      setBusy(false);
    }
  };

  const webhookBase = globalThis.location?.origin ?? '';
  const eventLabel = (kind?: AutomationEventKind) => {
    if (kind === 'session.finished') return t('settings.automation.triggers.event.session.finished');
    if (kind === 'session.failed') return t('settings.automation.triggers.event.session.failed');
    if (kind === 'scheduled.task.failed') return t('settings.automation.triggers.event.scheduled.task.failed');
    return '';
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.automation.title')}
      description={t('settings.page.automation.description')}
      headerEnd={<SettingsProjectSelector />}
      showSaveStatus
    >
      {loadError ? (
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.automation.loadError', { error: loadError })}</p>
      ) : null}
      {status && status.available ? (
        <p className={SETTINGS_HELPER_CLASS}>
          {[
            status.runningWorkflows ? t('settings.automation.status.running', { count: status.runningWorkflows }) : null,
            status.pendingApprovals ? t('settings.automation.status.pendingApprovals', { count: status.pendingApprovals }) : null,
          ].filter(Boolean).join(' · ')}
        </p>
      ) : null}

      {!projectID ? (
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.automation.toast.selectProject')}</p>
      ) : (
        <>
          <SettingsSection title={t('settings.automation.triggers.title')} description={t('settings.automation.triggers.description')} divider={false} headerAction={
            <Button size="sm" variant="outline" onClick={() => { setEditingTrigger(emptyTrigger()); setNewSecret(''); }}>
              <Icon name="add" className="size-4" />
              {t('settings.automation.triggers.add')}
            </Button>
          }>
            {triggers.length === 0 && !editingTrigger ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.automation.triggers.empty')}</p>
            ) : null}
            <div className={SETTINGS_OPTION_STACK_CLASS}>
              {triggers.map((trigger) => (
                <div key={trigger.id} className="flex flex-wrap items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate typography-ui-label">{trigger.name || trigger.id}</span>
                  <span className="typography-meta text-muted-foreground">
                    {trigger.kind === 'webhook'
                      ? t('settings.automation.triggers.kind.webhook')
                      : eventLabel(trigger.eventKind)}
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void fire(trigger.id)} disabled={busy}>
                    {t('settings.automation.triggers.fire')}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => { setEditingTrigger(trigger); setNewSecret(''); }} disabled={busy}>
                    {t('settings.automation.triggers.edit')}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => void removeTrigger(trigger.id)} disabled={busy}>
                    {t('settings.automation.triggers.delete')}
                  </Button>
                </div>
              ))}
            </div>

            {editingTrigger ? (
              <div className="mt-4 space-y-4 rounded-md border border-border/60 p-4">
                <SettingsFieldRow label={t('settings.automation.triggers.name')}>
                  <Input
                    value={editingTrigger.name}
                    onChange={(event) => setEditingTrigger({ ...editingTrigger, name: event.target.value })}
                    className="h-8 min-w-0 flex-1 px-3 max-w-[28ch]"
                    aria-label={t('settings.automation.triggers.name')}
                  />
                </SettingsFieldRow>
                <SettingsFieldRow label={t('settings.automation.triggers.kind')}>
                  <Select
                    value={editingTrigger.kind}
                    onValueChange={(value) => {
                      // SAFETY: Select only offers webhook | event values defined above.
                      setEditingTrigger({ ...editingTrigger, kind: value as AutomationTrigger['kind'] });
                    }}
                  >
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.triggers.kind')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="webhook">{t('settings.automation.triggers.kind.webhook')}</SelectItem>
                      <SelectItem value="event">{t('settings.automation.triggers.kind.event')}</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsFieldRow>
                {editingTrigger.kind === 'event' ? (
                  <SettingsFieldRow label={t('settings.automation.triggers.eventKind')}>
                    <Select
                      value={editingTrigger.eventKind ?? 'session.finished'}
                      onValueChange={(value) => {
                        // SAFETY: Select only offers the EVENT_KINDS values defined above.
                        setEditingTrigger({ ...editingTrigger, eventKind: value as AutomationEventKind });
                      }}
                    >
                      <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.triggers.eventKind')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>{eventLabel(kind)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsFieldRow>
                ) : (
                  <SettingsFieldRow label={t('settings.automation.triggers.secret')} info={t('settings.automation.triggers.secretInfo')}>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={newSecret}
                      onChange={(event) => setNewSecret(event.target.value)}
                      placeholder="••••••••••••••••"
                      className="h-8 min-w-0 flex-1 px-3 max-w-[28ch]"
                      aria-label={t('settings.automation.triggers.secret')}
                    />
                  </SettingsFieldRow>
                )}
                <SettingsFieldRow label={t('settings.automation.triggers.targetWorkflow')}>
                  <Select
                    value={editingTrigger.targetWorkflowId || 'none'}
                    onValueChange={(value) => setEditingTrigger({ ...editingTrigger, targetWorkflowId: value === 'none' ? '' : value })}
                  >
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.triggers.targetWorkflow')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">—</SelectItem>
                      {workflows.map((workflow) => (
                        <SelectItem key={workflow.id} value={workflow.id}>{workflow.name || workflow.id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsFieldRow>
                <SettingsCheckboxRow
                  checked={editingTrigger.enabled}
                  onChange={(checked) => setEditingTrigger({ ...editingTrigger, enabled: checked })}
                  label={t('settings.automation.triggers.enabled')}
                  ariaLabel={t('settings.automation.triggers.enabled')}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveTrigger()} disabled={busy}>
                    {t('settings.automation.policy.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingTrigger(null)} disabled={busy}>
                    {t('settings.automation.policy.rule.remove')}
                  </Button>
                </div>
                {editingTrigger.kind === 'webhook' ? (
                  <p className={SETTINGS_HELPER_CLASS}>
                    {t('settings.automation.triggers.webhookUrl')}: <code className="break-all">{`${webhookBase}/api/webhooks/${projectID}/${editingTrigger.id}`}</code>
                  </p>
                ) : null}
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection title={t('settings.automation.workflows.title')} description={t('settings.automation.workflows.description')} headerAction={
            <Button size="sm" variant="outline" onClick={() => setEditingWorkflow(emptyWorkflow())} disabled={busy}>
              <Icon name="add" className="size-4" />
              {t('settings.automation.workflows.add')}
            </Button>
          }>
            {workflows.length === 0 && !editingWorkflow ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.automation.workflows.empty')}</p>
            ) : null}
            <div className={SETTINGS_OPTION_STACK_CLASS}>
              {workflows.map((workflow) => (
                <div key={workflow.id} className="py-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left typography-ui-label hover:underline"
                      onClick={() => setExpandedWorkflow(expandedWorkflow === workflow.id ? null : workflow.id)}
                    >
                      {workflow.name || workflow.id} ({workflow.steps.length})
                    </button>
                    <Button size="xs" variant="ghost" onClick={() => void run(workflow.id)} disabled={busy}>
                      {t('settings.automation.workflows.run')}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditingWorkflow(workflow)} disabled={busy}>
                      {t('settings.automation.workflows.edit')}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void removeWorkflow(workflow.id)} disabled={busy}>
                      {t('settings.automation.workflows.delete')}
                    </Button>
                  </div>
                  {expandedWorkflow === workflow.id ? (
                    <ol className="mt-1 space-y-0.5 pl-4 typography-meta text-muted-foreground">
                      {workflow.steps.map((step, index) => (
                        <li key={step.id} className="truncate">
                          {index + 1}. {step.name || step.id} · {step.kind === 'shell' ? t('settings.automation.workflows.step.kind.shell') : t('settings.automation.workflows.step.kind.prompt')}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ))}
            </div>

            {editingWorkflow ? (
              <div className="mt-4 space-y-4 rounded-md border border-border/60 p-4">
                <SettingsFieldRow label={t('settings.automation.workflows.name')}>
                  <Input
                    value={editingWorkflow.name}
                    onChange={(event) => setEditingWorkflow({ ...editingWorkflow, name: event.target.value })}
                    className="h-8 min-w-0 flex-1 px-3 max-w-[28ch]"
                    aria-label={t('settings.automation.workflows.name')}
                  />
                </SettingsFieldRow>
                <SettingsControlGroup title={t('settings.automation.workflows.steps')}>
                  <div className="space-y-3">
                    {editingWorkflow.steps.map((step, index) => (
                      <div key={step.id} className="space-y-2 rounded-md border border-border/40 p-3">
                        <div className="flex items-center gap-2">
                          <span className="typography-meta text-muted-foreground">{index + 1}</span>
                          <Input
                            value={step.name}
                            onChange={(event) => {
                              const steps = [...editingWorkflow.steps];
                              steps[index] = { ...step, name: event.target.value };
                              setEditingWorkflow({ ...editingWorkflow, steps });
                            }}
                            className="h-8 min-w-0 flex-1 px-3"
                            aria-label={t('settings.automation.workflows.step.name')}
                            placeholder={t('settings.automation.workflows.step.name')}
                          />
                          <Select
                            value={step.kind}
                            onValueChange={(value) => {
                              const steps = [...editingWorkflow.steps];
                              // SAFETY: Select only offers shell | prompt values defined above.
                              steps[index] = { ...step, kind: value as AutomationWorkflowStep['kind'] };
                              setEditingWorkflow({ ...editingWorkflow, steps });
                            }}
                          >
                            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.workflows.step.kind')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="shell">{t('settings.automation.workflows.step.kind.shell')}</SelectItem>
                              <SelectItem value="prompt">{t('settings.automation.workflows.step.kind.prompt')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={t('settings.automation.policy.rule.remove')}
                            onClick={() => setEditingWorkflow({ ...editingWorkflow, steps: editingWorkflow.steps.filter((s) => s.id !== step.id) })}
                          >
                            <Icon name="delete-bin" className="size-4" />
                          </Button>
                        </div>
                        {step.kind === 'shell' ? (
                          <Input
                            value={step.command ?? ''}
                            onChange={(event) => {
                              const steps = [...editingWorkflow.steps];
                              steps[index] = { ...step, command: event.target.value };
                              setEditingWorkflow({ ...editingWorkflow, steps });
                            }}
                            className="h-8 w-full px-3"
                            aria-label={t('settings.automation.workflows.step.command')}
                            placeholder={t('settings.automation.workflows.step.command')}
                          />
                        ) : (
                          <textarea
                            value={step.prompt ?? ''}
                            onChange={(event) => {
                              const steps = [...editingWorkflow.steps];
                              steps[index] = { ...step, prompt: event.target.value };
                              setEditingWorkflow({ ...editingWorkflow, steps });
                            }}
                            className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 typography-ui-label"
                            aria-label={t('settings.automation.workflows.step.prompt')}
                            placeholder={t('settings.automation.workflows.step.prompt')}
                          />
                        )}
                        <div className="flex flex-wrap items-center gap-3">
                          <Select
                            value={step.onFail}
                            onValueChange={(value) => {
                              const steps = [...editingWorkflow.steps];
                              // SAFETY: Select only offers stop | continue | retry values defined above.
                              steps[index] = { ...step, onFail: value as AutomationWorkflowStep['onFail'] };
                              setEditingWorkflow({ ...editingWorkflow, steps });
                            }}
                          >
                            <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.workflows.step.onFail')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="stop">{t('settings.automation.workflows.step.onFail.stop')}</SelectItem>
                              <SelectItem value="continue">{t('settings.automation.workflows.step.onFail.continue')}</SelectItem>
                              <SelectItem value="retry">{t('settings.automation.workflows.step.onFail.retry')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <label className="flex items-center gap-2 typography-meta text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={Boolean(step.waitForIdle)}
                              onChange={(event) => {
                                const steps = [...editingWorkflow.steps];
                                steps[index] = { ...step, waitForIdle: event.target.checked };
                                setEditingWorkflow({ ...editingWorkflow, steps });
                              }}
                              className="size-3.5"
                            />
                            {t('settings.automation.workflows.step.waitForIdle')}
                          </label>
                        </div>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingWorkflow({ ...editingWorkflow, steps: [...editingWorkflow.steps, emptyStep()] })}
                      disabled={editingWorkflow.steps.length >= 20}
                    >
                      <Icon name="add" className="size-4" />
                      {t('settings.automation.workflows.step.add')}
                    </Button>
                  </div>
                </SettingsControlGroup>
                <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
                  <SettingsFieldRow label={t('settings.automation.workflows.retry.maxRetries')}>
                    <Input
                      type="number"
                      min={0}
                      value={editingWorkflow.retry?.maxRetries ?? 0}
                      onChange={(event) => setEditingWorkflow({
                        ...editingWorkflow,
                        retry: { ...editingWorkflow.retry, maxRetries: Number(event.target.value) || 0 },
                      })}
                      className="h-8 w-24 px-3"
                      aria-label={t('settings.automation.workflows.retry.maxRetries')}
                    />
                  </SettingsFieldRow>
                  <SettingsFieldRow label={t('settings.automation.workflows.budget.maxTokens')}>
                    <Input
                      type="number"
                      min={0}
                      value={editingWorkflow.budget?.maxTokens ?? 0}
                      onChange={(event) => setEditingWorkflow({
                        ...editingWorkflow,
                        budget: { ...editingWorkflow.budget, maxTokens: Number(event.target.value) || 0 },
                      })}
                      className="h-8 w-32 px-3"
                      aria-label={t('settings.automation.workflows.budget.maxTokens')}
                    />
                  </SettingsFieldRow>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void saveWorkflow()} disabled={busy}>
                    {t('settings.automation.policy.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingWorkflow(null)} disabled={busy}>
                    {t('settings.automation.policy.rule.remove')}
                  </Button>
                </div>
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection
            title={t('settings.automation.policy.title')}
            description={t('settings.automation.policy.description')}
            titleAccessory={policy ? <span className="typography-meta text-muted-foreground">{t('settings.automation.policy.revision', { revision: policy.revision })}</span> : null}
            headerAction={
              <Button size="sm" variant="outline" onClick={() => setPolicyDraft([...policyDraft, emptyRule()])}>
                <Icon name="add" className="size-4" />
                {t('settings.automation.policy.add')}
              </Button>
            }
          >
            {policyDraft.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.automation.policy.empty')}</p>
            ) : null}
            <div className="space-y-3">
              {policyDraft.map((rule, index) => (
                <div key={rule.id} className="flex flex-wrap items-end gap-3 py-1">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => {
                        const next = [...policyDraft];
                        next[index] = { ...rule, enabled: event.target.checked };
                        setPolicyDraft(next);
                      }}
                      className="size-3.5"
                      aria-label={t('settings.automation.policy.rule.enabled')}
                    />
                    <span className="typography-meta">{t('settings.automation.policy.rule.enabled')}</span>
                  </label>
                  <Input
                    value={rule.name}
                    onChange={(event) => {
                      const next = [...policyDraft];
                      next[index] = { ...rule, name: event.target.value };
                      setPolicyDraft(next);
                    }}
                    className="h-8 w-40 px-3"
                    aria-label={t('settings.automation.policy.rule.name')}
                    placeholder={t('settings.automation.policy.rule.name')}
                  />
                  <Select
                    value={rule.action}
                    onValueChange={(value) => {
                      const next = [...policyDraft];
                      // SAFETY: Select only offers accept | deny | hold values defined above.
                      next[index] = { ...rule, action: value as AutomationPolicyAction };
                      setPolicyDraft(next);
                    }}
                  >
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.automation.policy.rule.action')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="accept">{t('settings.automation.policy.rule.action.accept')}</SelectItem>
                      <SelectItem value="deny">{t('settings.automation.policy.rule.action.deny')}</SelectItem>
                      <SelectItem value="hold">{t('settings.automation.policy.rule.action.hold')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={rule.toolPattern ?? ''}
                    onChange={(event) => {
                      const next = [...policyDraft];
                      next[index] = { ...rule, toolPattern: event.target.value };
                      setPolicyDraft(next);
                    }}
                    className="h-8 w-36 px-3"
                    aria-label={t('settings.automation.policy.rule.toolPattern')}
                    placeholder={t('settings.automation.policy.rule.toolPattern')}
                  />
                  <Input
                    value={rule.contentPattern ?? ''}
                    onChange={(event) => {
                      const next = [...policyDraft];
                      next[index] = { ...rule, contentPattern: event.target.value };
                      setPolicyDraft(next);
                    }}
                    className="h-8 w-44 px-3"
                    aria-label={t('settings.automation.policy.rule.contentPattern')}
                    placeholder={t('settings.automation.policy.rule.contentPattern')}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={t('settings.automation.policy.rule.remove')}
                    onClick={() => setPolicyDraft(policyDraft.filter((entry) => entry.id !== rule.id))}
                  >
                    <Icon name="delete-bin" className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Button size="sm" onClick={() => void savePolicy()} disabled={busy}>
                {t('settings.automation.policy.save')}
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection
            title={t('settings.automation.approvals.title')}
            description={t('settings.automation.approvals.description')}
            headerAction={
              approvals.length > 0 ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void resolveAll('approved')} disabled={busy}>
                    {t('settings.automation.approvals.approveAll')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void resolveAll('denied')} disabled={busy}>
                    {t('settings.automation.approvals.denyAll')}
                  </Button>
                </div>
              ) : null
            }
          >
            {approvals.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.automation.approvals.empty')}</p>
            ) : (
              <div className={SETTINGS_OPTION_STACK_CLASS}>
                {approvals.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center gap-2 py-1">
                    <span className="min-w-0 flex-1 truncate typography-ui-label">{entry.action}</span>
                    {entry.ruleName ? (
                      <span className="typography-meta text-muted-foreground">{t('settings.automation.approvals.rule', { name: entry.ruleName })}</span>
                    ) : null}
                    <Button size="xs" variant="ghost" onClick={() => void resolveOne(entry.permissionId, 'approved')} disabled={busy}>
                      {t('settings.automation.approvals.approve')}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void resolveOne(entry.permissionId, 'denied')} disabled={busy}>
                      {t('settings.automation.approvals.deny')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection title={t('settings.automation.audit.title')} description={t('settings.automation.audit.description')}>
            {audit.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.automation.audit.empty')}</p>
            ) : (
              <div className="space-y-1">
                {audit.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap gap-2 typography-meta text-muted-foreground">
                    <span className="tabular-nums">{new Date(entry.at).toLocaleString()}</span>
                    <span>{entry.kind}</span>
                    <span>{entry.status}</span>
                    {entry.error ? <span className="truncate text-[var(--status-error)]">{entry.error}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}
      {!loaded && projectID ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</p>
      ) : null}
    </SettingsPageLayout>
  );
}
