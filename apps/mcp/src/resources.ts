/**
 * MCP resources exposing session outputs (Project Brief, Implementation PRD)
 * to coding agents.
 *
 * Ownership: every read goes through
 * `AgentSessionRepository.getAgentSessionByIdForUser` before touching
 * anything else. A session that does not exist and a session owned by
 * another user produce the exact same "Not found" response — this handler
 * must never let a caller distinguish the two.
 *
 * Storage: output text is read straight from the `outputs.content` column —
 * `StorageAdapter`/S3 is not involved here. `content` is written to Postgres
 * on every `createOutput` call; `s3Key` + `StorageAdapter` exist only for the
 * separate presigned-URL download-as-file export feature (see Stack doc,
 * Section 8).
 */
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import type { OutputType } from "@shipwright/shared/domain/types";
import { Effect, Option } from "effect";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { Spans } from "@shipwright/observability";

const sessionIdParam = McpSchema.param("sessionId", AgentSessionId);

const readOutput = (type: OutputType) => (uri: string, sessionId: AgentSessionId) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      ...Spans.session(sessionId),
      ...Spans.mcpResourceType(type),
    });

    const user = yield* CurrentUser;
    yield* Effect.annotateCurrentSpan(Spans.user(user.id));

    const sessionRepo = yield* AgentSessionRepository;
    const outputRepo = yield* OutputRepository;

    const session = yield* sessionRepo.getAgentSessionByIdForUser({
      sessionId,
      userId: user.id,
    });

    if (Option.isNone(session)) {
      return yield* new McpSchema.InternalError({ message: "Not found" });
    }

    const output = yield* outputRepo.getLatestOutputByType({ sessionId, type });

    if (Option.isNone(output) || output.value.content === null) {
      return yield* new McpSchema.InternalError({ message: "Output not ready" });
    }

    // SHIP-158: returning a bare string here (relying on the registration-level
    // `mimeType` option below) silently drops mimeType from the actual
    // ReadResourceResult. Root-caused in effect's McpServer.ts source:
    // resolveResourceContent's string branch builds `{ uri, text: content }`
    // with no mimeType field at all — `options.mimeType` is only attached to
    // the resource's *listing* metadata (resources/list), never plumbed into
    // the resources/read response. Returning the full ReadResourceResult shape
    // ourselves bypasses that branch entirely (resolveResourceContent returns
    // non-string/Uint8Array content as-is).
    return {
      contents: [{ uri, mimeType: "text/plain", text: output.value.content }],
    };
  }).pipe(
    // McpServer.resource converts *any* failure or defect that escapes here
    // into an InternalError using the underlying message verbatim.
    // EffectDrizzleQueryError#message embeds the raw SQL query + params —
    // it must never reach the client unnormalized.
    Effect.catchTag("EffectDrizzleQueryError", () =>
      Effect.fail(new McpSchema.InternalError({ message: "Internal error" })),
    ),
    Effect.withSpan("mcp/resources/read"),
  );

export const BriefResource = McpServer.resource`shipwright://session/${sessionIdParam}/brief`({
  name: "Project Brief",
  description: "Stakeholder-facing Project Brief for this session",
  mimeType: "text/plain",
  content: readOutput("project_brief"),
});

export const PrdResource = McpServer.resource`shipwright://session/${sessionIdParam}/prd`({
  name: "Implementation PRD",
  description: "Coding-agent-facing Implementation PRD for this session",
  mimeType: "text/plain",
  content: readOutput("implementation_prd"),
});
