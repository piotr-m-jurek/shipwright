import { Context, Effect, Layer } from "effect";
import type { InsertChunk, SelectChunk } from "../types.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { chunks } from "../schema.ts";
import { DB } from "../index.ts";
import { and, asc, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";

interface Interface {
  createChunks: (data: InsertChunk[]) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

  getChunksByDocumentId: (
    documentId: string,
  ) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

  getChunksBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

  getChunksBySimilarity: (payload: {
    sessionId: AgentSessionId;
    embedding: readonly number[];
    limit: number;
  }) => Effect.Effect<
    {
      similarity: number;
      content: string;
      headingPath: string[] | null;
      pageNumber: number | null;
    }[],
    EffectDrizzleQueryError
  >;
}

export class Chunk extends Context.Service<Chunk, Interface>()(
  "@shipwright/api/db/services/chunk/Chunk",
) {
  static readonly layer = Layer.effect(
    Chunk,
    Effect.gen(function* () {
      const db = yield* DB;

      const createChunks = Effect.fnUntraced(function* (data: InsertChunk[]) {
        return yield* db.insert(chunks).values(data).returning();
      });

      const getChunksByDocumentId = Effect.fnUntraced(function* (documentId: string) {
        return yield* db
          .select()
          .from(chunks)
          .where(eq(chunks.documentId, documentId))
          .orderBy(asc(chunks.chunkIndex));
      });

      const getChunksBySessionId = Effect.fnUntraced(function* (sessionId: AgentSessionId) {
        return yield* db.select().from(chunks).where(eq(chunks.sessionId, sessionId));
      });

      const getChunksBySimilarity = Effect.fnUntraced(function* ({
        embedding,
        sessionId,
        limit,
      }: {
        embedding: readonly number[];
        sessionId: AgentSessionId;
        limit: number;
      }) {
        const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, [...embedding])})`;
        return yield* db
          .select({
            similarity,
            content: chunks.content,
            headingPath: chunks.headingPath,
            pageNumber: chunks.pageNumber,
          })
          .from(chunks)
          .where(and(gt(similarity, 0.5), eq(chunks.sessionId, sessionId)))
          .orderBy((t) => desc(t.similarity))
          .limit(limit);
      });

      return {
        createChunks,
        getChunksByDocumentId,
        getChunksBySessionId,
        getChunksBySimilarity,
      };
    }),
  );
}
