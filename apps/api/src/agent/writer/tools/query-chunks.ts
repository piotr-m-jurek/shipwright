import { Effect, pipe, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ChunkRepository } from "../../../db/repositories/chunk-repository.ts";
import { EmbeddingService } from "../../embedding-service.ts";

class QueryChunksToolParameters extends Schema.Class<QueryChunksToolParameters>(
  "QueryChunksToolParameters",
)({
  query: pipe(
    Schema.String,
    Schema.annotate({
      description: "A specific question or topic to search for in the source documents",
    }),
  ),
  limit: pipe(
    Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
    Schema.annotate({
      description: "Maximum number of chunks to return (1–20, default 5). Omit to use the default.",
    }),
  ),
}) {}

class QueryChunksToolSuccess extends Schema.Class<QueryChunksToolSuccess>("QueryChunksToolSuccess")(
  {
    results: Schema.Array(
      Schema.Struct({
        similarity: Schema.Number,
        content: Schema.String,
        headingPath: Schema.NullOr(Schema.Array(Schema.String)),
        pageNumber: Schema.NullOr(Schema.Number),
      }),
    ),
  },
) {}

export const QueryChunksTool = Tool.make("query-chunks", {
  description:
    "Retrieve relevant document chunks by semantic similarity. Use when you need more " +
    "detail on a specific area not covered in the summaries, or to verify a specific claim " +
    "against source material.",
  parameters: QueryChunksToolParameters,
  success: QueryChunksToolSuccess,
  failureMode: "return",
});

export const QueryChunksToolkit = Toolkit.make(QueryChunksTool);

export const makeQueryChunksLayer = (sessionId: AgentSessionId) =>
  QueryChunksToolkit.toLayer(
    Effect.gen(function* () {
      const db = yield* ChunkRepository;
      const chunkster = yield* EmbeddingService;

        return QueryChunksToolkit.of({
          "query-chunks": Effect.fn("tools/query-chunks")(function* ({
            query,
            limit: rawLimit,
          }: typeof QueryChunksToolParameters.Type) {
            const limit = rawLimit ?? 5;
          const embedding = yield* pipe(
            chunkster.embedText(query),
            Effect.tapError((cause) =>
              Effect.logError("query-chunks: embedding failed, falling back to empty results").pipe(
                Effect.annotateLogs({ sessionId, query, cause: String(cause) }),
              ),
            ),
            Effect.catch(() => Effect.succeed([])),
          );

          const similarChunks = yield* db
            .getChunksBySimilarity({ sessionId, embedding, limit })
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("query-chunks: DB query failed", cause).pipe(
                  Effect.as([] as QueryChunksToolSuccess["results"]),
                ),
              ),
            );

          return new QueryChunksToolSuccess({ results: similarChunks });
        }),
      });
    }),
  );
