import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

import type { MessageRecord } from '@/lib/messageCompletion';

import {
    TASK_TAIL_MAX_CHARS,
    TASK_TAIL_MAX_LINE_CHARS,
    TASK_TAIL_MAX_LINES,
    buildTaskRollingTail,
} from './taskRollingTail';

const messageInfoSchema = z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
});

const textPartSchema = z.object({
    id: z.string(),
    type: z.literal('text'),
    text: z.string(),
});

const toolPartSchema = z.object({
    id: z.string(),
    type: z.literal('tool'),
    tool: z.string(),
    state: z.object({
        status: z.enum(['running', 'completed']),
        title: z.string().optional(),
        input: z.record(z.string(), z.string()).optional(),
    }),
});

const reasoningPartSchema = z.object({
    id: z.string(),
    type: z.literal('reasoning'),
    text: z.string(),
});

const toPart = <T extends z.ZodTypeAny>(schema: T, value: z.input<T>): Part => {
    const parsed = schema.parse(value);
    // SAFETY: test fixtures are built from schema-parsed values the tail walker accepts.
    return parsed as Part;
};

const toRecord = (info: z.input<typeof messageInfoSchema>, parts: Part[]): MessageRecord => {
    const parsed = messageInfoSchema.parse(info);
    // SAFETY: schema-parsed identity fields are sufficient for MessageRecord.info in these fixtures.
    return { info: parsed as MessageRecord['info'], parts };
};

const assistant = (id: string, parts: Part[]): MessageRecord =>
    toRecord({ id, role: 'assistant' }, parts);

const user = (id: string): MessageRecord => toRecord({ id, role: 'user' }, []);

const textPart = (text: string): Part =>
    toPart(textPartSchema, { id: `text-${text.slice(0, 8)}`, type: 'text', text });

const runningTool = (tool: string, title?: string, input?: Record<string, string>): Part =>
    toPart(toolPartSchema, {
        id: `tool-${tool}`,
        type: 'tool',
        tool,
        state: { status: 'running', title, input },
    });

const completedTool = (tool: string, title?: string): Part =>
    toPart(toolPartSchema, {
        id: `tool-done-${tool}`,
        type: 'tool',
        tool,
        state: { status: 'completed', title },
    });

describe('buildTaskRollingTail', () => {
    test('returns empty for no records', () => {
        expect(buildTaskRollingTail([])).toBe('');
    });

    test('stops at the last user message so only the current turn shows', () => {
        const records = [
            user('old-user'),
            assistant('old-assistant', [textPart('stale answer')]),
            user('turn-user'),
            assistant('turn-assistant', [textPart('live answer')]),
        ];

        expect(buildTaskRollingTail(records)).toBe('live answer');
    });

    test('keeps the newest lines within the line budget, oldest to newest', () => {
        const lines = Array.from({ length: TASK_TAIL_MAX_LINES + 4 }, (_, index) => `line-${index}`);
        const records = [assistant('a', [textPart(lines.join('\n'))])];
        const tail = buildTaskRollingTail(records);
        const tailLines = tail.split('\n');

        expect(tailLines).toHaveLength(TASK_TAIL_MAX_LINES);
        expect(tailLines[0]).toBe(`line-${lines.length - TASK_TAIL_MAX_LINES}`);
        expect(tailLines[tailLines.length - 1]).toBe(`line-${lines.length - 1}`);
    });

    test('clips a single overlong line to the per-line budget', () => {
        const longLine = 'x'.repeat(TASK_TAIL_MAX_LINE_CHARS + 80);
        const tail = buildTaskRollingTail([assistant('a', [textPart(longLine)])]);

        expect(tail.length).toBeLessThanOrEqual(TASK_TAIL_MAX_LINE_CHARS);
        expect(tail.startsWith('…')).toBe(true);
        expect(tail.endsWith('x')).toBe(true);
    });

    test('respects the total character budget across lines', () => {
        const chunk = 'y'.repeat(200);
        const records = [assistant('a', [textPart([chunk, chunk, chunk, chunk, chunk, chunk].join('\n'))])];
        const tail = buildTaskRollingTail(records);

        expect(tail.length).toBeLessThanOrEqual(TASK_TAIL_MAX_CHARS);
        expect(tail.split('\n').length).toBeLessThanOrEqual(TASK_TAIL_MAX_LINES);
    });

    test('emits a running tool line with display name and title', () => {
        const records = [assistant('a', [runningTool('bash', 'npm test')])];

        expect(buildTaskRollingTail(records)).toBe('Shell Command npm test');
    });

    test('falls back to the tool input path when a running tool has no title', () => {
        const records = [assistant('a', [runningTool('read', undefined, { filePath: 'src/a.ts' })])];

        expect(buildTaskRollingTail(records)).toBe('Read File src/a.ts');
    });

    test('ignores completed tools so the summary list stays the completion source', () => {
        const records = [
            assistant('a', [completedTool('bash', 'npm test'), textPart('after tools')]),
        ];

        expect(buildTaskRollingTail(records)).toBe('after tools');
    });

    test('places a running tool after earlier text from the same message', () => {
        const records = [
            assistant('a', [textPart('thinking…'), runningTool('bash', 'npm test')]),
        ];

        expect(buildTaskRollingTail(records)).toBe('thinking…\nShell Command npm test');
    });

    test('skips non-text and non-running-tool parts', () => {
        const records = [
            assistant('a', [
                toPart(reasoningPartSchema, { id: 'reason', type: 'reasoning', text: 'hidden' }),
                textPart('visible'),
            ]),
        ];

        expect(buildTaskRollingTail(records)).toBe('visible');
    });
});
