/**
 * Toggles the session approval gate: while on, tool permissions for this
 * session (and its lineage) stay on screen even when auto-accept is on.
 *
 * Same pointer guards as PermissionAutoAcceptButton so a tap cannot dismiss
 * the mobile keyboard mid-tap.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SessionApprovalGateButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isInteractive: boolean;
    gateEnabled: boolean;
    handleGateToggle: () => void;
    withTooltip?: boolean;
};

export const SessionApprovalGateButton = React.memo(function SessionApprovalGateButton(props: SessionApprovalGateButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        isInteractive,
        gateEnabled,
        handleGateToggle,
        withTooltip = false,
    } = props;

    const ariaLabel = gateEnabled
        ? t('chat.chatInput.sessionApprovalGate.disable')
        : t('chat.chatInput.sessionApprovalGate.enable');
    const tooltipLabel = gateEnabled
        ? t('chat.chatInput.sessionApprovalGate.on')
        : t('chat.chatInput.sessionApprovalGate.off');

    const button = (
        <button
            type="button"
            onClick={handleGateToggle}
            className={cn(
                footerIconButtonClass,
                'rounded-md hover:bg-transparent',
                !isInteractive && 'opacity-30',
            )}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-pressed={gateEnabled}
            aria-label={ariaLabel}
            title={ariaLabel}
        >
            {gateEnabled ? (
                <Icon name="shield-keyhole" className={cn(iconSizeClass)} style={{ color: 'var(--status-warning)' }} />
            ) : (
                <Icon name="shield" className={cn(iconSizeClass)} />
            )}
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {button}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {tooltipLabel}
            </TooltipContent>
        </Tooltip>
    );
});
