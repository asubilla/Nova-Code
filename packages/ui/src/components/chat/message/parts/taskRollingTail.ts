import { z } from 'zod';

import type { MessageRecord } from '@/lib/messageCompletion';
import { getToolMetadata } from '@/lib/toolHelpers';

export const TASK_TAIL_MAX_LINES = 6;
export const TASK_TAIL_MAX_CHARS = 1024;
export const TASK_TAIL_MAX_LINE_CHARS = 240;

const toolStateTailSchema = z.object({
    status: z.string().optional(),
    title: z.string().optional(),
    input: z.unknown().optional(),
});

const tailPartSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('text'),
        text: z.string(),
    }),
    z.object({
        type: z.literal('tool'),
        tool: z.string().optional(),
        state: toolStateTailSchema.optional(),
    }).passthrough(),
]);

const toolInputPathSchema = z.object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
});

const clipTailLine = (line: string): string => {
    const trimmed = line.trim();
    if (trimmed.length <= TASK_TAIL_MAX_LINE_CHARS) {
        return trimmed;
    }
    return `…${trimmed.slice(-(TASK_TAIL_MAX_LINE_CHARS - 1))}`;
};

const formatRunningToolLine = (part: {
    tool?: string;
    state?: { title?: string; input?: unknown };
}): string => {
    const rawTool = part.tool?.trim().toLowerCase();
    const toolName = rawTool && rawTool.length > 0 ? rawTool : 'tool';
    const displayName = getToolMetadata(toolName).displayName;
    const title = part.state?.title?.trim();
    if (title && title.length > 0) {
        return `${displayName} ${title}`;
    }

    const inputParsed = toolInputPathSchema.safeParse(part.state?.input ?? {});
    if (inputParsed.success) {
        const path = inputParsed.data.filePath
            ?? inputParsed.data.file_path
            ?? inputParsed.data.path
            ?? inputParsed.data.url;
        const trimmedPath = path?.trim();
        if (trimmedPath && trimmedPath.length > 0) {
            return `${displayName} ${trimmedPath}`;
        }
    }
    return displayName;
};

/**
 * Derived rolling tail of a child session's current-turn activity for the Task
 * card: newest-first walk of assistant text lines and running-tool labels,
 * stopped at the last user message and capped by line/char budgets. Pure —
 * never stores a buffer; cleanup is free when the caller stops deriving it.
 */
export const buildTaskRollingTail = (records: readonly MessageRecord[]): string => {
    if (records.length === 0) {
        return '';
    }

    const lines: string[] = [];
    let charBudget = TASK_TAIL_MAX_CHARS;

    const pushLine = (raw: string): boolean => {
        const clipped = clipTailLine(raw);
        if (clipped.length === 0) {
            return true;
        }
        if (lines.length >= TASK_TAIL_MAX_LINES || charBudget <= 0) {
            return false;
        }
        const nextBudget = charBudget - clipped.length - 1;
        if (nextBudget < 0) {
            const slice = clipped.slice(Math.max(0, clipped.length - charBudget));
            if (slice.length > 0) {
                lines.unshift(slice);
            }
            charBudget = 0;
            return false;
        }
        lines.unshift(clipped);
        charBudget = nextBudget;
        return lines.length < TASK_TAIL_MAX_LINES && charBudget > 0;
    };

    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        const role = record.info.role;
        if (role === 'user') {
            break;
        }
        if (role !== 'assistant') {
            continue;
        }

        for (let partIndex = record.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const partParsed = tailPartSchema.safeParse(record.parts[partIndex]);
            if (!partParsed.success) {
                continue;
            }

            const part = partParsed.data;
            if (part.type === 'tool') {
                if (part.state?.status !== 'running') {
                    continue;
                }
                if (!pushLine(formatRunningToolLine(part))) {
                    return lines.join('\n');
                }
                continue;
            }

            const textLines = part.text.split('\n');
            for (let lineIndex = textLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
                if (!pushLine(textLines[lineIndex])) {
                    return lines.join('\n');
                }
            }
        }
    }

    return lines.join('\n');
};
