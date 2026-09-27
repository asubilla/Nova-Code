import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type NovaCodeMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getNovaCodeMetadata = (metadata: SessionMetadataRecord): NovaCodeMetadata => {
  const value = metadata.novacode;
  return isRecord(value) ? value as NovaCodeMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getNovaCodeMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getNovaCodeMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getNovaCodeMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getNovaCodeMetadata(metadata);
  return {
    ...metadata,
    novacode: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getNovaCodeMetadata(metadata);
  return {
    ...metadata,
    novacode: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getNovaCodeMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restNovaCode = { ...current };
  delete restNovaCode.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restNovaCode).length > 0) {
    next.novacode = restNovaCode;
  } else {
    delete next.novacode;
  }
  return next;
};
