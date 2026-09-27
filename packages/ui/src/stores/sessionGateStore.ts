import { create } from "zustand";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { getRuntimeKey } from "@/lib/runtime-switch";

type SessionGateMap = Record<string, boolean>;

const booleanSessionsSchema = z
    .record(z.string().min(1), z.unknown())
    .transform((entries) => {
        const sessions: SessionGateMap = {};
        for (const [sessionId, gated] of Object.entries(entries)) {
            const parsed = z.boolean().safeParse(gated);
            if (parsed.success) sessions[sessionId] = parsed.data;
        }
        return sessions;
    })
    .catch({});

const sessionGateSnapshotSchema = z.object({
    sessions: z.unknown(),
    revision: z.number().int().nonnegative().optional(),
});

type SessionGateSnapshot = z.infer<typeof sessionGateSnapshotSchema>;

export const sessionGateUpdatedEventSchema = z.object({
    type: z.literal("novacode:session-approval-gates.updated"),
    properties: sessionGateSnapshotSchema,
});

const readSnapshot = async (response: Response): Promise<SessionGateSnapshot> => {
    if (!response.ok) throw new Error(`Session approval gates request failed (${response.status})`);
    const parsed = sessionGateSnapshotSchema.safeParse(await response.json());
    if (!parsed.success) {
        throw new Error("Invalid session approval gates response");
    }
    return parsed.data;
};

const requestSnapshot = async (path: string, init?: RequestInit) => readSnapshot(await runtimeFetch(path, init));

const resolveLineage = (
    sessionID: string,
    sessionById: ReadonlyMap<string, Session>,
): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = sessionID;

    while (current && !seen.has(current)) {
        seen.add(current);
        result.push(current);
        current = sessionById.get(current)?.parentID;
    }

    return result;
};

export const sessionGatedByPolicy = (input: {
    gates: SessionGateMap;
    sessionById: ReadonlyMap<string, Session>;
    sessionID: string;
}): boolean => {
    const { gates, sessionById, sessionID } = input;
    if (Object.keys(gates).length === 0) return false;
    const lineage = resolveLineage(sessionID, sessionById);

    for (const id of lineage) {
        if (!Object.prototype.hasOwnProperty.call(gates, id)) {
            continue;
        }
        return gates[id] === true;
    }

    return false;
};

interface SessionGateStore {
    gates: SessionGateMap;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    hydrate: () => Promise<void>;
    applySnapshot: (snapshot: SessionGateSnapshot, expectedRuntimeKey?: string) => void;
    reset: () => void;
    isSessionGated: (sessionId: string) => boolean;
    setSessionGate: (sessionId: string, gated: boolean) => Promise<void>;
}

type SessionGateOperation = { generation: number; runtimeKey: string; sequence: number };
let generation = 0;
let operationSequence = 0;
let latestStartedSequence = 0;
const pendingSavingOperations = new Set<number>();

const beginOperation = (): SessionGateOperation => {
    const operation = { generation, runtimeKey: getRuntimeKey(), sequence: ++operationSequence };
    latestStartedSequence = operation.sequence;
    return operation;
};

const isCurrentOperation = (operation: SessionGateOperation) => (
    operation.generation === generation && operation.runtimeKey === getRuntimeKey()
);

export const useSessionGateStore = create<SessionGateStore>()((set, get) => ({
    gates: {},
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,

    hydrate: async () => {
        const operation = beginOperation();
        const snapshot = await requestSnapshot("/api/session-approval-gates");
        if (!isCurrentOperation(operation)) return;
        if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
        get().applySnapshot(snapshot, operation.runtimeKey);
    },

    reset: () => {
        generation += 1;
        latestStartedSequence = 0;
        pendingSavingOperations.clear();
        set({ gates: {}, loaded: false, saving: false, lastAppliedRevision: -1 });
    },

    applySnapshot: (snapshot, expectedRuntimeKey) => {
        if (expectedRuntimeKey && expectedRuntimeKey !== getRuntimeKey()) return;
        const sessions = booleanSessionsSchema.parse(snapshot.sessions);
        const revision = snapshot.revision;
        set((state) => {
            if (revision === undefined && state.lastAppliedRevision >= 0) return state;
            if (revision !== undefined && revision < state.lastAppliedRevision) return state;
            const next: Partial<SessionGateStore> = {
                gates: sessions,
                loaded: true,
            };
            if (revision !== undefined) next.lastAppliedRevision = revision;
            return next;
        });
    },

    isSessionGated: (sessionId) => {
        if (!sessionId) return false;
        const gates = get().gates;
        if (Object.keys(gates).length === 0) return false;
        return sessionGatedByPolicy({
            gates,
            sessionById: getAllSyncSessionMap(),
            sessionID: sessionId,
        });
    },

    setSessionGate: async (sessionId, gated) => {
        if (!sessionId) return;
        const operation = beginOperation();
        pendingSavingOperations.add(operation.sequence);
        set({ saving: true });
        try {
            const snapshot = await requestSnapshot(
                `/api/session-approval-gates/sessions/${encodeURIComponent(sessionId)}`,
                {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ gated }),
                },
            );
            if (!isCurrentOperation(operation)) return;
            if (snapshot.revision === undefined && operation.sequence !== latestStartedSequence) return;
            get().applySnapshot(snapshot, operation.runtimeKey);
        } finally {
            if (isCurrentOperation(operation)) {
                pendingSavingOperations.delete(operation.sequence);
                set({ saving: pendingSavingOperations.size > 0 });
            }
        }
    },
}));
