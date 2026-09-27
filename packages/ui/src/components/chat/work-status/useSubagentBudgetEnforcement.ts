import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useAllLiveSessions, useAllSessionStatuses, useSession } from '@/sync/sync-context';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import { getSubagentBudget } from '@/lib/subagentBudget';
import { abortCurrentOperation } from '@/sync/session-actions';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';

/**
 * Child subtree costs at or above an active parent budget that are still busy.
 * Pure so the enforcement path can be unit-tested without mounting the hook.
 */
export function selectBudgetViolations(
  children: Session[],
  perChildCost: Map<string, number>,
  costBudget: number | null,
  isBusy: (sessionId: string) => boolean,
): string[] {
  if (costBudget === null) return [];
  const violations: string[] = [];
  for (const child of children) {
    const cost = perChildCost.get(child.id) ?? 0;
    if (cost >= costBudget && isBusy(child.id)) {
      violations.push(child.id);
    }
  }
  return violations;
}

/**
 * Enforces the optional per-child cost budget on the parent session: a busy
 * child whose subtree spend has reached the budget is aborted. Mounted from
 * ChatContainer so enforcement does not depend on the work-status panel being
 * visible. No budget (opt-in) means this is a no-op beyond cheap subscriptions.
 */
export function useSubagentBudgetEnforcement(
  sessionId: string | null,
  directory: string | null | undefined,
): void {
  const session = useSession(sessionId ?? '', directory ?? undefined);
  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  const { perChildCost } = useSubagentCostRollup(sessionId);
  const costBudget = getSubagentBudget(session)?.costBudget ?? null;

  // Aborts already issued for this budget value — re-running the effect on
  // unrelated live-session churn must not re-abort (and re-toast) a child the
  // user already saw stop. Reset when the budget itself changes.
  const abortedForBudgetRef = React.useRef<{ budget: number; ids: Set<string> }>({
    budget: costBudget ?? -1,
    ids: new Set(),
  });
  React.useEffect(() => {
    if (abortedForBudgetRef.current.budget !== (costBudget ?? -1)) {
      abortedForBudgetRef.current = { budget: costBudget ?? -1, ids: new Set() };
    }
  }, [costBudget]);

  const children = React.useMemo(
    () => (sessionId
      ? liveSessions.filter((candidate) => candidate.parentID === sessionId)
      : []),
    [liveSessions, sessionId],
  );

  React.useEffect(() => {
    if (costBudget === null || children.length === 0) return;
    const violations = selectBudgetViolations(
      children,
      perChildCost,
      costBudget,
      (id) => statuses[id]?.type === 'busy',
    ).filter((id) => !abortedForBudgetRef.current.ids.has(id));
    if (violations.length === 0) return;

    for (const id of violations) abortedForBudgetRef.current.ids.add(id);
    for (const id of violations) {
      void abortCurrentOperation(id);
    }
    const dictionary = useI18nStore.getState().dictionary;
    toast.info(formatMessage(dictionary, 'chat.workStatus.subagent.budget.abortToast'));
  }, [costBudget, children, perChildCost, statuses]);
}
