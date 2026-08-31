/**
 * Production entrypoint — owns all infrastructure wiring (OTLP, Langfuse,
 * embeddings, job handlers, message queue) and the Bun runtime bootstrap.
 *
 * The only file in apps/api allowed to import @effect/platform-bun. Kept
 * separate from server.ts so server.ts (ApiLayer, AllRoutesLayer) stays a
 * pure route/API definition module with no infra or runtime-specific
 * dependencies — importable from vitest, whose test workers don't run
 * inside the actual Bun binary and crash on @effect/platform-bun's
 * top-level `import ... from "bun"` in BunRedis.js.
 */

import { Effect, Layer, pipe } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { StorageAdapter } from "@shipwright/storage";
import { ConfigService } from "@shipwright/config";
import { OtlpLayer } from "@shipwright/observability";
import { LangfuseClient } from "../observability/langfuse-client";
import { LangfuseSpanTransformerLayer } from "../observability/langfuse-span-transformer";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { McpTokenRepository } from "@shipwright/db/repositories/mcp-token-repository";
import { AppDBLiveLayer } from "@shipwright/db";
import { EmbeddingService, HuggingFaceTeiEmbeddingModelLayerProvided } from "@shipwright/embedding";
import { AnthropicClientLayer } from "../agent/providers";
import { MessageQueue } from "@shipwright/queue";
import { JobHandlers } from "../queue/job-handlers";
import { AllRoutesLayer } from "./server";

const OtlpLayerProvided = pipe(
  OtlpLayer,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

const EmbeddingServiceLayer = EmbeddingService.layer.pipe(
  Layer.provideMerge(HuggingFaceTeiEmbeddingModelLayerProvided),
);

const LangfuseClientLayer = LangfuseClient.layer.pipe(
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

const JobHandlersLayer = pipe(
  JobHandlers.layer,
  Layer.provide([
    AgentSessionRepository.layer,
    DocumentRepository.layer,
    ChunkRepository.layer,
    SummaryRepository.layer,
    ClarificationRepository.layer,
    OutputRepository.layer,
    OtlpLayerProvided,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
    MessageQueue.layer,
    LangfuseClientLayer,
    LangfuseSpanTransformerLayer,
  ]),
  Layer.provide(AppDBLiveLayer),
);

const ServiceLayer = pipe(
  OtlpLayerProvided,
  Layer.provideMerge([
    AgentSessionRepository.layer,
    DocumentRepository.layer,
    ChunkRepository.layer,
    SummaryRepository.layer,
    ClarificationRepository.layer,
    OutputRepository.layer,
    McpTokenRepository.layer,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
    LangfuseClientLayer,
  ]),
  Layer.provideMerge(JobHandlersLayer),
  Layer.provideMerge(MessageQueue.layer),
  Layer.provideMerge(AppDBLiveLayer),
);

const StartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Server starting").pipe(
      Effect.annotateLogs({ port: 3000, env: process.env.NODE_ENV ?? "development" }),
    );
    yield* Effect.addFinalizer(() => Effect.logInfo("Server shutting down"));
  }),
);

pipe(
  HttpRouter.serve(Layer.merge(AllRoutesLayer, StartupLayer)),
  Layer.provideMerge(ServiceLayer),
  Layer.provideMerge(BunHttpServer.layer({ port: 3000, hostname: "0.0.0.0" })),
  Layer.launch,
  BunRuntime.runMain,
);
