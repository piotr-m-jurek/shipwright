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
import { ConfigService } from "@shipwright/config";
import { AppDBLiveLayer } from "@shipwright/db";
import { OtlpLayer } from "@shipwright/observability";
import { LangfuseClient } from "../observability/langfuse-client";
import { LangfuseSpanTransformerLayer } from "../observability/langfuse-span-transformer";
import { EmbeddingService, HuggingFaceTeiEmbeddingModelLayerProvided } from "@shipwright/embedding";
import { AnthropicClientLayer } from "../agent/providers";
import { MessageQueue } from "@shipwright/queue";
import { JobHandlers } from "../queue/job-handlers";
import { AllRoutesLayer, InfrastructureLayer } from "./server";

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

// Reuses server.ts's InfrastructureLayer reference (repos + DB + storage +
// config) rather than re-listing those layers, so Effect's identity-based
// layer memoization actually guarantees one DB pool / one StorageAdapter
// instance across the whole app — not just within this file.
//
// AppDBLiveLayer is provideMerge'd (not provide'd), so DB/SqlClient stay
// exposed in the output — session-debug-sse.ts and session-questions-sse.ts
// (part of AllRoutesLayer) query DB directly for queue messages rather than
// through a repository (tracked as a violation in SHIP-156), so they need
// DB available in the ambient context, not just consumed internally here.
const RuntimeInfrastructureLayer = Layer.mergeAll(
  InfrastructureLayer,
  OtlpLayerProvided,
  EmbeddingServiceLayer,
  AnthropicClientLayer,
  LangfuseClientLayer,
  LangfuseSpanTransformerLayer,
  MessageQueue.layer,
).pipe(Layer.provideMerge(AppDBLiveLayer));

const JobHandlersLayer = pipe(
  JobHandlers.layer,
  Layer.provide(RuntimeInfrastructureLayer),
);

const ServiceLayer = pipe(
  RuntimeInfrastructureLayer,
  Layer.provideMerge(JobHandlersLayer),
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
