import { Context, Effect, Layer } from "effect";
import type {
  DocumentSummaryInsert,
  DocumentSummarySelect,
  SummaryItemInsert,
  SummaryItemSelect,
} from "../types.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { documentSummaries, summaryItems } from "../schema.ts";
import { DB } from "../index.ts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

// ── Domain types ──────────────────────────────────────────────────────────

type ItemWithSource = {
  text: string;
  sourceDocument: string;
  confidence: "high" | "medium" | "low";
};

type DocumentSummary = {
  sourceDocument: string;
  summary: string;
  requirements: readonly ItemWithSource[];
  constraints: readonly ItemWithSource[];
  assumptions: readonly ItemWithSource[];
};

/** Summary row joined with its items, shaped as a rich domain object. */
export type ReconstructedSummary = DocumentSummary & {
  id: string;
  documentId: string;
  sessionId: string;
  tokenCount: number;
  version: number;
};

// ── Helper ────────────────────────────────────────────────────────────────

function reconstructSummaries(
  summaryRows: {
    id: string;
    documentId: string;
    sessionId: string;
    sourceDocument: string;
    summary: string;
    tokenCount: number;
    version: number;
  }[],
  itemRows: SummaryItemSelect[],
): ReconstructedSummary[] {
  const itemsBySummaryId = new Map<string, SummaryItemSelect[]>();
  for (const item of itemRows) {
    const list = itemsBySummaryId.get(item.summaryId);
    if (list) {
      list.push(item);
    } else {
      itemsBySummaryId.set(item.summaryId, [item]);
    }
  }

  return summaryRows.map((row) => {
    const items = itemsBySummaryId.get(row.id) ?? [];
    return {
      id: row.id,
      documentId: row.documentId,
      sessionId: row.sessionId,
      sourceDocument: row.sourceDocument,
      summary: row.summary,
      tokenCount: row.tokenCount,
      version: row.version,
      requirements: items
        .filter((i) => i.itemType === "requirement")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
      constraints: items
        .filter((i) => i.itemType === "constraint")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
      assumptions: items
        .filter((i) => i.itemType === "assumption")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
    };
  });
}

// ── Service ───────────────────────────────────────────────────────────────

interface Interface {
  createDocumentSummary: (
    data: DocumentSummaryInsert,
  ) => Effect.Effect<DocumentSummarySelect, EffectDrizzleQueryError>;

  createSummaryItems: (
    data: SummaryItemInsert[],
  ) => Effect.Effect<SummaryItemSelect[], EffectDrizzleQueryError>;

  getCurrentDocumentSummaryVersion: (args: {
    documentId: string;
    sessionId: AgentSessionId;
  }) => Effect.Effect<number, EffectDrizzleQueryError>;

  getFinalSummariesBySession: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<ReconstructedSummary[], EffectDrizzleQueryError>;
}

export class DbSummary extends Context.Service<DbSummary, Interface>()(
  "@shipwright/api/db/services/summary/DbSummary",
) {
  static readonly layer = Layer.effect(
    DbSummary,
    Effect.gen(function* () {
      const db = yield* DB;

      const createDocumentSummary = Effect.fnUntraced(function* (data: DocumentSummaryInsert) {
        const [result] = yield* db.insert(documentSummaries).values(data).returning();
        return result;
      });

      const createSummaryItems = Effect.fnUntraced(function* (data: SummaryItemInsert[]) {
        if (data.length === 0) return [] as SummaryItemSelect[];
        return yield* db.insert(summaryItems).values(data).returning();
      });

      const getCurrentDocumentSummaryVersion = Effect.fnUntraced(function* ({
        documentId,
        sessionId,
      }: {
        documentId: string;
        sessionId: AgentSessionId;
      }) {
        const results = yield* db
          .select({ version: documentSummaries.version })
          .from(documentSummaries)
          .where(
            and(
              eq(documentSummaries.documentId, documentId),
              eq(documentSummaries.sessionId, sessionId),
            ),
          )
          .orderBy(desc(documentSummaries.version))
          .limit(1);

        if (results.length === 0) return 0;
        return results[0].version;
      });

      const getFinalSummariesBySession = Effect.fnUntraced(function* (sessionId: AgentSessionId) {
        const summaryRows = yield* db
          .selectDistinctOn([documentSummaries.documentId], {
            id: documentSummaries.id,
            documentId: documentSummaries.documentId,
            sessionId: documentSummaries.sessionId,
            sourceDocument: documentSummaries.sourceDocument,
            summary: documentSummaries.content,
            tokenCount: documentSummaries.tokenCount,
            version: documentSummaries.version,
          })
          .from(documentSummaries)
          .where(
            and(
              eq(documentSummaries.sessionId, sessionId),
              eq(documentSummaries.summaryType, "final"),
            ),
          )
          .orderBy(asc(documentSummaries.documentId), desc(documentSummaries.version));

        if (summaryRows.length === 0) return [] as ReconstructedSummary[];

        const summaryIds = summaryRows.map((r) => r.id);

        const itemRows = yield* db
          .select()
          .from(summaryItems)
          .where(
            summaryIds.length === 1
              ? eq(summaryItems.summaryId, summaryIds[0]!)
              : inArray(summaryItems.summaryId, summaryIds),
          )
          .orderBy(asc(summaryItems.summaryId), asc(summaryItems.orderIndex));

        return reconstructSummaries(summaryRows, itemRows);
      });

      return {
        createDocumentSummary,
        createSummaryItems,
        getCurrentDocumentSummaryVersion,
        getFinalSummariesBySession,
      };
    }),
  );
}
