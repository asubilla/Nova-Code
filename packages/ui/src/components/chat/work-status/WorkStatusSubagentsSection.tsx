import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync, useSession } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { formatCost } from './subagentCost';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import { getSubagentBudget } from '@/lib/subagentBudget';
import { SubagentBudgetDialog } from './SubagentBudgetDialog';
import type { State } from '@/sync/types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'subagents';

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a child session has no representation in the transcript, so this
 * panel is the only place it becomes visible. Also hosts the optional
 * per-child cost budget (opt-in, set on the parent session).
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [budgetDialogOpen, setBudgetDialogOpen] = React.useState(false);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  const children = React.useMemo(
    () => (sessionId ? liveSessions.filter((candidate) => candidate.parentID === sessionId) : []),
    [liveSessions, sessionId],
  );

  // Each child's own subtree total (its cost plus every descendant of its
  // own), so nested subagent-of-subagent cost rolls up under the immediate
  // child row shown here rather than disappearing.
  const { perChildCost } = useSubagentCostRollup(sessionId);
  const parentSession = useSession(sessionId ?? '', directory ?? undefined);
  const costBudget = getSubagentBudget(parentSession)?.costBudget ?? null;

  // One subscription covers every child: per-session hooks would multiply
  // store subscriptions by the number of subagents.
  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const questions = useDirectorySync(React.useCallback((state: State) => state.question, []));

  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  // Subagents appearing where there were none is the one moment this section
  // has something urgent to say, so it opens itself. Only on the empty→present
  // edge: re-expanding on every count change would fight a user who just
  // collapsed it.
  const hadChildren = React.useRef(children.length > 0);
  React.useEffect(() => {
    const present = children.length > 0;
    if (present && !hadChildren.current) setSectionExpanded(SECTION_ID, true);
    hadChildren.current = present;
  }, [children.length, setSectionExpanded]);

  // Same branch the transcript's Task tool takes: surfaces that cannot host an
  // embedded panel navigate to the child session instead of opening a tab.
  const openChildSession = React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  useReportWorkStatusPresence('subagents', children.length > 0 || costBudget !== null);

  // Stay visible while a budget is armed even between runs, so the cap can be
  // managed before the next subagent spawns; otherwise match the original
  // "no children, no section" collapse.
  if (children.length === 0 && costBudget === null) return null;

  const busyChildren = children.filter((child) => statuses[child.id]?.type === 'busy').length;
  const budgetAction = sessionId ? (
    <WorkStatusRowAction
      onClick={() => setBudgetDialogOpen(true)}
      ariaLabel={t('chat.workStatus.action.setBudget')}
      tone={costBudget !== null ? 'info' : 'default'}
    >
      {costBudget !== null ? formatCost(costBudget) : t('chat.workStatus.subagent.budget.set')}
    </WorkStatusRowAction>
  ) : null;

  return (
    <>
      <WorkStatusCollapsibleSection
        id={SECTION_ID}
        title={t('chat.workStatus.section.subagents')}
        icon="ai-agent"
        defaultExpanded
        summary={busyChildren > 0 ? `${busyChildren}/${children.length}` : children.length}
        action={budgetAction}
      >
        <div className="max-h-56 overflow-y-auto">
          {children.map((child) => {
            const blocked = (permissions[child.id]?.length ?? 0) > 0;
            const asked = (questions[child.id]?.length ?? 0) > 0;
            const busy = statuses[child.id]?.type === 'busy';
            const label = child.title?.trim() || t('chat.workStatus.subagent.untitled');
            const childCost = perChildCost.get(child.id) ?? 0;
            const overBudget = costBudget !== null && childCost >= costBudget;
            return (
              <WorkStatusRow
                key={child.id}
                onClick={directory ? () => openChildSession(child.id, label) : undefined}
                ariaLabel={t('chat.workStatus.action.openSubagent', { name: label })}
                label={label}
                value={(
                  <>
                    {blocked ? (
                      <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
                    ) : asked ? (
                      <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
                    ) : busy ? (
                      <WorkStatusValue tone="info">{t('chat.workStatus.subagent.working')}</WorkStatusValue>
                    ) : (
                      <WorkStatusValue tone="muted">{t('chat.workStatus.subagent.done')}</WorkStatusValue>
                    )}
                    {childCost > 0 ? (
                      <WorkStatusValue tone={overBudget ? 'error' : 'muted'}>
                        {overBudget
                          ? t('chat.workStatus.subagent.budget.over', { cost: formatCost(childCost) })
                          : formatCost(childCost)}
                      </WorkStatusValue>
                    ) : null}
                  </>
                )}
              />
            );
          })}
        </div>
      </WorkStatusCollapsibleSection>
      {sessionId ? (
        <SubagentBudgetDialog
          open={budgetDialogOpen}
          onOpenChange={setBudgetDialogOpen}
          sessionId={sessionId}
          directory={directory ?? undefined}
        />
      ) : null}
    </>
  );
};
