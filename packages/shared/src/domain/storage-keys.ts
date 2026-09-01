import { Schema } from "effect";
import type { AgentSessionId } from "./ids";
import type { OutputType } from "./types";

export const StorageKey = Schema.String.pipe(Schema.brand("StorageKey"));
export type StorageKey = typeof StorageKey.Type;

/**
 * The S3 key naming convention for a generated output — a domain decision
 * (naming scheme, path structure, versioning format), not an application
 * concern. Single source of truth so the format only needs to change here.
 */
export const outputStorageKey = (
  sessionId: AgentSessionId,
  type: OutputType,
  version: number,
): StorageKey => StorageKey.make(`outputs/${sessionId}/${type}_v${version}.md`);
