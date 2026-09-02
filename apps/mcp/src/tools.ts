/**
 * MCP tool exposing semantic search over a session's source document chunks.
 *
 * Ownership: same convention as resources.ts — every call goes through
 * `AgentSessionRepository.getAgentSessionByIdForUser` before touching
 * `ChunkRepository`. A nonexistent session and a session owned by another
 * user both fail with the same generic `SessionNotFoundError` message.
 *
 * CurrentUser is per-request (provided dynamically by McpAuthMiddlewareLayer,
 * not a static Layer). `Tool.make`'s `dependencies` option is the supported
 * mechanism for declaring it as an additional per-call requirement — verified
 * that Effect's `provideContext`/`provide` only narrow the specific tags they
 * define and don't strip other already-ambient services, so CurrentUser
 * (provided by the outer per-request auth middleware) correctly reaches this
 * handler despite McpServer's own internal build-time-captured context
 * wrapping around it.
 *
 * Any error that escapes this handler and isn't `SessionNotFoundError`
 * (the only declared `failure` on the tool) is converted by
 * `McpServer.toolkit`'s own dispatch into a fixed, non-descriptive internal
 * error message — it never forwards the underlying error's message. That is
 * a different (safer, by construction) behavior than `McpServer.resource`,
 * which forwards the underlying message verbatim (see resources.ts) and
 * required an explicit normalization there.
 *
 * Embedding/DB failures during the search itself degrade to empty results
 * rather than failing the call outright — mirrors the identical defensive
 * pattern already used by the internal Writer's own query-chunks tool
 * (apps/api/src/agent/writer/tools/query-chunks.ts).
 */
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { EmbeddingService } from "@shipwright/embedding";
import { CurrentUser } from "@shipwright/shared/middleware";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Effect, Layer, Option, pipe, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { Spans } from "@shipwright/observability";

class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "shipwright/mcp/SessionNotFoundError",
  { message: Schema.String },
) {}

const QuerySessionTool = Tool.make("query_session", {
  description:
    "Semantic search over the source documents for a session. Use to answer questions " +
    "about specifics not already covered by the session's Project Brief or Implementation PRD.",
  parameters: Schema.Struct({
    sessionId: AgentSessionId,
    query: Schema.String.annotate({
      description: "A specific question or topic to search for in the session's source documents",
    }),
    limit: Schema.optionalKey(
      Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    ).annotate({
      description: "Maximum number of chunks to return (1–20, default 5). Omit to use the default.",
    }),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        similarity: Schema.Finite,
        content: Schema.String,
        headingPath: Schema.NullOr(Schema.Array(Schema.String)),
        pageNumber: Schema.NullOr(Schema.Finite),
      }),
    ),
  }),
  failure: SessionNotFoundError,
  failureMode: "return",
  dependencies: [CurrentUser],
});

export const QuerySessionToolkit = Toolkit.make(QuerySessionTool);

// Handler implementations only — does NOT register the tool with McpServer.
// (`McpServer.toolkit(...)` below does that; it consumes this layer.)
const QuerySessionHandlersLayer = QuerySessionToolkit.toLayer(
  Effect.gen(function* () {
    const sessionRepo = yield* AgentSessionRepository;
    const chunkRepo = yield* ChunkRepository;
    const embedder = yield* EmbeddingService;

    return QuerySessionToolkit.of({
      query_session: Effect.fn("mcp/tools/query_session")(function* ({
        sessionId,
        query,
        limit: rawLimit,
      }) {
        const user = yield* CurrentUser;
        const limit = rawLimit ?? 5;

        yield* Effect.annotateCurrentSpan({
          ...Spans.session(sessionId),
          ...Spans.user(user.id),
        });

        const session = yield* sessionRepo
          .getAgentSessionByIdForUser({ sessionId, userId: user.id })
          .pipe(Effect.orDie);

        if (Option.isNone(session)) {
          return yield* new SessionNotFoundError({ message: "Not found" });
        }

        const embedding = yield* pipe(
          embedder.embedText(query),
          Effect.tapError((cause) =>
            Effect.logError(
              "mcp/query_session: embedding failed, falling back to empty results",
            ).pipe(Effect.annotateLogs({ sessionId, query, cause: String(cause) })),
          ),
          Effect.orElseSucceed(() => []),
        );

        const results = yield* chunkRepo
          .getChunksBySimilarity({ sessionId, embedding, limit })
          .pipe(
            Effect.catch((cause) =>
              Effect.logError("mcp/query_session: DB query failed", cause).pipe(
                Effect.as(
                  [] as {
                    similarity: number;
                    content: string;
                    headingPath: string[] | null;
                    pageNumber: number | null;
                  }[],
                ),
              ),
            ),
          );

        yield* Effect.annotateCurrentSpan(Spans.mcpResultCount(results.length));

        return { results };
      }),
    });
  }),
);

// Fully self-registering, mirroring BriefResource/PrdResource in
// resources.ts — server.ts just needs to include this in Layer.mergeAll.
// CurrentUser remains an open requirement of this layer (declared via the
// Tool's `dependencies` above) — satisfied by McpAuthMiddlewareLayer being
// present in the same final composition (see module doc comment).
export const QuerySessionToolkitLayer = McpServer.toolkit(QuerySessionToolkit).pipe(
  Layer.provide(QuerySessionHandlersLayer),
);
