import { Context, Effect, Layer } from "effect";
import type { InsertChunk, SelectChunk } from "../types.ts";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { chunks } from "../schema.ts";
import { DB } from "../index.ts";
import { and, asc, cosineDistance, desc, eq, gt, sql } from "drizzle-orm";

interface Interface {
  createChunks: (data: InsertChunk[]) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

  getChunksByDocumentId: (
    documentId: DocumentId,
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

export class ChunkRepository extends Context.Service<ChunkRepository, Interface>()(
  "@shipwright/api/db/repositories/chunk/ChunkRepository",
) {
  static readonly layer = Layer.effect(
    ChunkRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createChunks = Effect.fn("db/createChunks")(function* (data: InsertChunk[]) {
        return yield* db.insert(chunks).values(data).returning();
      });

      const getChunksByDocumentId = Effect.fn("db/getChunksByDocumentId")(function* (documentId: DocumentId) {
        const rows = yield* db
          .select()
          .from(chunks)
          .where(eq(chunks.documentId, documentId))
          .orderBy(asc(chunks.chunkIndex));
        yield* Effect.annotateCurrentSpan({ "db.row_count": rows.length });
        return rows;
      });

      const getChunksBySessionId = Effect.fn("db/getChunksBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db.select().from(chunks).where(eq(chunks.sessionId, sessionId));
        yield* Effect.annotateCurrentSpan({ "db.row_count": rows.length });
        return rows;
      });

      const getChunksBySimilarity = Effect.fn("db/getChunksBySimilarity")(function* ({
        embedding,
        sessionId,
        limit,
      }: {
        embedding: readonly number[];
        sessionId: AgentSessionId;
        limit: number;
      }) {
        const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, [...embedding])})`;
        const rows = yield* db
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
        yield* Effect.annotateCurrentSpan({ "db.row_count": rows.length });
        return rows;
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
