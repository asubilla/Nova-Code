import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NumberInput } from '@/components/ui/number-input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { getSubagentBudget } from '@/lib/subagentBudget';
import { setSubagentBudget } from '@/lib/subagentBudgetActions';
import { useSession } from '@/sync/sync-context';

interface SubagentBudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  directory?: string;
}

const DEFAULT_COST_BUDGET = 1;

/**
 * Opt-in cost cap for each subagent's own subtree spend. One number on the
 * parent applies to every child independently; busy children over the cap are
 * aborted by useSubagentBudgetEnforcement.
 */
export function SubagentBudgetDialog({ open, onOpenChange, sessionId, directory }: SubagentBudgetDialogProps) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const session = useSession(sessionId, directory);
  const existing = getSubagentBudget(session);

  const [enabled, setEnabled] = React.useState(false);
  const [costBudget, setCostBudget] = React.useState<number>(DEFAULT_COST_BUDGET);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setEnabled(Boolean(existing));
    setCostBudget(existing?.costBudget ?? DEFAULT_COST_BUDGET);
    // Seed only on open so live metadata updates cannot clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const budgetValue = enabled ? costBudget : null;
  const budgetChanged = budgetValue !== (existing?.costBudget ?? null);
  const canSave = budgetValue !== null ? budgetValue > 0 : Boolean(existing);

  const run = React.useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onOpenChange(false);
    } catch (error) {
      console.warn('[subagent-budget] action failed:', error);
      toast.error(t('chat.workStatus.subagent.budget.failed'));
    } finally {
      setBusy(false);
    }
  }, [onOpenChange, t]);

  const handleSave = () => run(() => setSubagentBudget(sessionId, directory, budgetValue));
  const handleClear = () => run(() => setSubagentBudget(sessionId, directory, null));

  const body = (
    <div className="space-y-3">
      <p className="typography-meta text-muted-foreground">
        {t('chat.workStatus.subagent.budget.dialogDescription')}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div
          className="flex cursor-pointer items-center gap-2"
          role="button"
          tabIndex={0}
          aria-pressed={enabled}
          onClick={() => setEnabled((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              setEnabled((value) => !value);
            }
          }}
        >
          <Checkbox
            checked={enabled}
            onChange={setEnabled}
            ariaLabel={t('chat.workStatus.subagent.budget.label')}
          />
          <span className="typography-ui-label text-foreground">
            {t('chat.workStatus.subagent.budget.label')}
          </span>
        </div>
        {enabled ? (
          <NumberInput
            value={costBudget}
            onValueChange={(value) =>
              setCostBudget(value > 0 ? value : DEFAULT_COST_BUDGET)}
            min={0.01}
            max={10_000}
            step={0.5}
            aria-label={t('chat.workStatus.subagent.budget.costLabel')}
          />
        ) : null}
      </div>
      <div className="flex items-center gap-2 pt-1">
        {existing ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={handleClear}
          >
            {t('chat.workStatus.subagent.budget.clear')}
          </Button>
        ) : null}
        <div className="flex flex-1 items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('chat.workStatus.subagent.budget.cancel')}
          </Button>
          <Button size="sm" disabled={busy || !canSave || !budgetChanged} onClick={handleSave}>
            {t('chat.workStatus.subagent.budget.save')}
          </Button>
        </div>
      </div>
    </div>
  );

  const title = t('chat.workStatus.subagent.budget.dialogTitle');

  if (isMobile) {
    return (
      <MobileOverlayPanel open={open} title={title} onClose={() => onOpenChange(false)}>
        {body}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
