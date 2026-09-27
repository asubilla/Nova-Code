import { patchSessionMetadata } from '@/sync/session-actions';
import { parseCostBudget, withSubagentBudget } from '@/lib/subagentBudget';

/**
 * Set or clear the per-child subagent cost budget on the parent session.
 * `costBudget` null removes the budget and stops enforcement.
 */
export async function setSubagentBudget(
  sessionId: string,
  directory: string | null | undefined,
  costBudget: number | null,
): Promise<void> {
  const normalized = costBudget === null ? null : parseCostBudget(costBudget);
  if (costBudget !== null && normalized === null) {
    throw new Error('Subagent budget must be a positive finite number');
  }
  await patchSessionMetadata(sessionId, directory, (metadata) =>
    withSubagentBudget(metadata, normalized));
}
