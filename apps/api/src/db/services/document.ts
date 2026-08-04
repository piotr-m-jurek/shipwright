import { Context, Effect, Layer, Option } from "effect";
import { InsertDocument, SelectDocument } from "../types.ts";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { DB } from "../index.ts";
import { documents } from "../schema.ts";
import { eq } from "drizzle-orm";
import { AgentSessionId } from "@shipwright/shared/domain/ids";

interface Interface {
  createDocument: (data: InsertDocument) => Effect.Effect<SelectDocument, EffectDrizzleQueryError>;

  getDocumentById: (
    id: string,
  ) => Effect.Effect<Option.Option<SelectDocument>, EffectDrizzleQueryError>;

  getDocumentsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<SelectDocument[], EffectDrizzleQueryError>;

  updateDocument: (
    documentId: string,
    payload: Pick<SelectDocument, "status" | "tokenCount">,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  updateDocumentStatus: (
    documentId: string,
    status: SelectDocument["status"],
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  updateDocumentTokenCount: (
    documentId: string,
    tokenCount: number,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;
}

export class DbDocument extends Context.Service<DbDocument, Interface>()(
  "@shipwright/api/db/services/document",
) {
  static readonly layer = Layer.effect(
    DbDocument,
    Effect.gen(function* () {
      const db = yield* DB;

      const createDocument = Effect.fnUntraced(function* (data: InsertDocument) {
        const [result] = yield* db.insert(documents).values(data).returning();
        return result;
      });

      const getDocumentById = Effect.fnUntraced(function* (id: string) {
        const results = yield* db.select().from(documents).where(eq(documents.id, id)).limit(1);
        return Option.fromIterable(results);
      });

      const getDocumentsBySessionId = Effect.fnUntraced(function* (sessionId: AgentSessionId) {
        return yield* db.select().from(documents).where(eq(documents.sessionId, sessionId));
      });

      const updateDocument = Effect.fnUntraced(function* (
        documentId: string,
        payload: Pick<SelectDocument, "status" | "tokenCount">,
      ) {
        yield* db.update(documents).set(payload).where(eq(documents.id, documentId));
      });

      const updateDocumentStatus = Effect.fnUntraced(function* (
        documentId: string,
        status: SelectDocument["status"],
      ) {
        yield* db.update(documents).set({ status }).where(eq(documents.id, documentId));
      });

      const updateDocumentTokenCount = Effect.fnUntraced(function* (
        documentId: string,
        tokenCount: number,
      ) {
        yield* db.update(documents).set({ tokenCount }).where(eq(documents.id, documentId));
      });

      return {
        createDocument,
        getDocumentById,
        getDocumentsBySessionId,
        updateDocument,
        updateDocumentStatus,
        updateDocumentTokenCount,
      };
    }),
  );
}
