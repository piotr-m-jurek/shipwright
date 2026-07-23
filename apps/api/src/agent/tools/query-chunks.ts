import { Effect, Layer, pipe, Schema } from "effect";
import { EmbeddingModel, Tool, Toolkit } from "effect/unstable/ai";
import { OpenAiEmbeddingModel } from "@effect/ai-openai";
import { DatabaseService } from "../../db/queries.js";
import { OpenAiClientLayer } from "../providers.js";
import { ChunkingService } from "../chunking-service.ts";

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
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    Schema.withDecodingDefault(Effect.succeed(5)),
    Schema.annotate({
      description: "Maximum number of chunks to return (1–20, default 5)",
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

const requiredLayers = pipe(
  OpenAiEmbeddingModel.model("text-embedding-3-small", { dimensions: 1536 }),
  Layer.provide(OpenAiClientLayer),
);

export const makeQueryChunksLayer = (sessionId: string) =>
  QueryChunksToolkit.toLayer(
    Effect.gen(function* () {
      const db = yield* DatabaseService;
      const embeddingModel = yield* EmbeddingModel.EmbeddingModel;

      return QueryChunksToolkit.of({
        "query-chunks": Effect.fn("tools/query-chunks")(function* ({ query, limit }) {
          const chunkster = yield* ChunkingService;
          const embedding = yield* chunkster.embedText(query);


          const similarChunks = yield* db
            .getChunksBySimilarity({ sessionId, embedding, limit })
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("query-chunks: DB query failed", cause).pipe(
                  Effect.as([] as QueryChunksToolSuccess["results"]),
                ),
              ),
            );

          return { results: similarChunks };
        }),
      });
    }),
  ).pipe(Layer.provide(requiredLayers));
