import { z } from 'zod';
import type { Session } from '@opencode-ai/sdk/v2';
import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';

// Optional cost budget for subagent spend, stored on the PARENT session under
// metadata.novacode.subagentBudget. One number applies to each child's own
// subtree cost independently — crossing it aborts that child, not the parent.
// Opt-in: absent payload means no budget and no enforcement.
export interface SubagentBudgetPayload {
  /** US dollars, finite and > 0. */
  costBudget: number;
}

const costBudgetSchema = z
  .number()
  .refine(Number.isFinite)
  .refine((value) => value > 0);

const budgetPayloadSchema = z.object({ costBudget: costBudgetSchema });

const metadataBudgetSchema = z.object({
  novacode: z.object({ subagentBudget: budgetPayloadSchema }),
});

/** Boundary parse for a positive finite USD budget; rejects non-numbers and non-positives. */
export function parseCostBudget(value: number): number | null {
  const result = costBudgetSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function getSubagentBudget(session: Session | null | undefined): SubagentBudgetPayload | null {
  const result = metadataBudgetSchema.safeParse(getSessionMetadata(session));
  return result.success ? result.data.novacode.subagentBudget : null;
}

/** Returns metadata with the budget set, or cleared when `costBudget` is null. */
export function withSubagentBudget(
  metadata: SessionMetadataRecord,
  costBudget: number | null,
): SessionMetadataRecord {
  const next: SessionMetadataRecord = { ...metadata };
  const novacode = z.record(z.string(), z.unknown()).safeParse(metadata.novacode);
  const namespace = novacode.success ? novacode.data : {};

  if (costBudget === null) {
    const rest = { ...namespace };
    delete rest.subagentBudget;
    if (Object.keys(rest).length > 0) {
      next.novacode = rest;
    } else {
      delete next.novacode;
    }
    return next;
  }

  next.novacode = { ...namespace, subagentBudget: { costBudget } };
  return next;
}
