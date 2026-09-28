import React from 'react';
import { isDesktopShell } from '@/lib/desktop';
import { warmDesktopHostStatuses } from '@/lib/desktopHostStatus';

/**
 * Startup of the local instance pool.
 *
 * Discovery scans the machine for Nova Code servers, folds what it finds into
 * the persisted host list, and warms every instance's probe status — so the
 * failover layer has targets before the first request fails and the switcher
 * opens on real values instead of "Checking". Background work: never blocks
 * render, failures are silent (the pool simply stays as configured).
 */
export const useInstancePoolSync = (): void => {
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    void warmDesktopHostStatuses().catch(() => {
      // Discovery or probing is best-effort; the configured pool still works.
    });
  }, []);
};
