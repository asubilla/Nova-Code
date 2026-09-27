import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type PendingChildRevert = {
  sessionId: string;
  messageId: string;
  sessionTitle: string;
} | null;

export type ChildRevertConfirm = {
  requestRevert: (sessionId: string, messageId: string) => void;
  dialog: React.ReactNode;
};

/**
 * Revert for a subagent (session with parentID) asks first: the parent chat
 * and sibling subagents stay untouched, but the shared working tree means
 * file snapshots can roll back to this child's boundary. Root sessions keep
 * the existing one-click path.
 */
export function useChildRevertConfirm(): ChildRevertConfirm {
  const { t } = useI18n();
  const [pending, setPending] = React.useState<PendingChildRevert>(null);
  const untitled = t('sessions.sidebar.session.untitled');

  const requestRevert = React.useCallback((sessionId: string, messageId: string) => {
    if (!sessionId || !messageId) return;
    const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
    if (!session?.parentID) {
      void useSessionUIStore.getState().revertToMessage(sessionId, messageId);
      return;
    }
    setPending({
      sessionId,
      messageId,
      sessionTitle: session.title?.trim() || untitled,
    });
  }, [untitled]);

  const confirm = React.useCallback(() => {
    if (!pending) return;
    const { sessionId, messageId } = pending;
    setPending(null);
    void useSessionUIStore.getState().revertToMessage(sessionId, messageId);
  }, [pending]);

  const cancel = React.useCallback(() => setPending(null), []);

  const dialog = pending ? (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t('chat.revert.childConfirm.title')}</DialogTitle>
          <DialogDescription>
            {t('chat.revert.childConfirm.description', { name: pending.sessionTitle })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="w-full justify-end gap-2">
          <Button variant="outline" size="sm" onClick={cancel}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={confirm}>
            {t('chat.revert.childConfirm.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return { requestRevert, dialog };
}
