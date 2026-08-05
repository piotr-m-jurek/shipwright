import { Context, Effect, Layer, Option } from "effect";
import { InsertDocument, SelectDocument } from "../types.ts";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { DB } from "../index.ts";
import { documents } from "../schema.ts";
import { eq } from "drizzle-orm";
import { type AgentSessionId, type DocumentId } from "@shipwright/shared/domain/ids";
import type { TokenCount } from "@shipwright/shared/domain/value-objects";

interface Interface {
  createDocument: (data: InsertDocument) => Effect.Effect<SelectDocument, EffectDrizzleQueryError>;

  getDocumentById: (
    id: DocumentId,
  ) => Effect.Effect<Option.Option<SelectDocument>, EffectDrizzleQueryError>;

  getDocumentsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<SelectDocument[], EffectDrizzleQueryError>;

  updateDocument: (
    documentId: DocumentId,
    payload: Pick<SelectDocument, "status" | "tokenCount">,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  updateDocumentStatus: (
    documentId: DocumentId,
    status: SelectDocument["status"],
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  updateDocumentTokenCount: (
    documentId: DocumentId,
    tokenCount: TokenCount,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;
}

export class DocumentRepository extends Context.Service<DocumentRepository, Interface>()(
  "@shipwright/api/db/repositories/document/DocumentRepository",
) {
  static readonly layer = Layer.effect(
    DocumentRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createDocument = Effect.fn("db/createDocument")(function* (data: InsertDocument) {
        const [result] = yield* db.insert(documents).values(data).returning();
        return result;
      });

      const getDocumentById = Effect.fn("db/getDocumentById")(function* (id: DocumentId) {
        const results = yield* db.select().from(documents).where(eq(documents.id, id)).limit(1);
        return Option.fromIterable(results);
      });

      const getDocumentsBySessionId = Effect.fn("db/getDocumentsBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db.select().from(documents).where(eq(documents.sessionId, sessionId));
        yield* Effect.annotateCurrentSpan({ "db.row_count": rows.length });
        return rows;
      });

      const updateDocument = Effect.fn("db/updateDocument")(function* (
        documentId: DocumentId,
        payload: Pick<SelectDocument, "status" | "tokenCount">,
      ) {
        yield* db.update(documents).set(payload).where(eq(documents.id, documentId));
      });

      const updateDocumentStatus = Effect.fn("db/updateDocumentStatus")(function* (
        documentId: DocumentId,
        status: SelectDocument["status"],
      ) {
        yield* db.update(documents).set({ status }).where(eq(documents.id, documentId));
      });

      const updateDocumentTokenCount = Effect.fn("db/updateDocumentTokenCount")(function* (
        documentId: DocumentId,
        tokenCount: TokenCount,
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
