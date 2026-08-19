import { Effect, Layer, pipe } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { StorageAdapter } from "../storage/index";
import { Api } from "@shipwright/shared/api";
import { SessionCompute } from "./handlers/session-compute";
import { ConfigService } from "@shipwright/config";
import { OtlpLayer } from "../observability/observability";
import { LangfuseClient } from "../observability/langfuse-client";
import { LangfuseSpanTransformerLayer } from "../observability/langfuse-span-transformer";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { AppDBLiveLayer } from "@shipwright/db";
import { AuthorizationLayer } from "./authorization";
import { EmbeddingService } from "../agent/embedding-service";
import {
  AnthropicClientLayer,
  HuggingFaceTeiEmbeddingModelLayerProvided,
} from "../agent/providers";
import { AuthRouteLayer } from "./handlers/auth";
import { SessionStorage } from "./handlers/session-storage";
import { SessionResults } from "./handlers/session-results";
import { PublicApi } from "./handlers/public";
import { MessageQueue } from "@shipwright/queue";
import { JobHandlers } from "../queue/job-handlers";
import { RequestLoggingMiddlewareLayer } from "../observability/http-middleware";
import { SessionDebugSseLayer } from "./handlers/session-debug-sse";
import { SessionQuestionsSseLayer } from "./handlers/session-questions-sse";

export const ApiGroupsLayer = Layer.provide([
  SessionStorage,
  SessionCompute,
  SessionResults,
  PublicApi,
]);

export const RepositoriesLayer = Layer.provide([
  AgentSessionRepository.layer,
  DocumentRepository.layer,
  ChunkRepository.layer,
  SummaryRepository.layer,
  ClarificationRepository.layer,
  OutputRepository.layer,
]);

export const ApiLayer = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  ApiGroupsLayer,
  Layer.provide(AuthorizationLayer),
  RepositoriesLayer,
  Layer.provide(StorageAdapter.layer),
  Layer.provide(AppDBLiveLayer),
  Layer.provide(ConfigService.layer),
);

const DocsLayer = HttpApiScalar.layer(Api, { path: "/docs" });

// HttpRouter.cors returns a global middleware Layer directly.
// We unwrap the config to get allowedOrigins, then build the Layer.
const CorsLayer = pipe(
  Effect.map(ConfigService, (config) =>
    HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins, credentials: true }),
  ),
  Layer.unwrap,
  Layer.provide(ConfigService.layer),
);

const AllRoutesLayer = Layer.mergeAll(
  AuthRouteLayer,
  SessionDebugSseLayer,
  SessionQuestionsSseLayer,
  ApiLayer,
  DocsLayer,
  CorsLayer,
  RequestLoggingMiddlewareLayer,
);

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
  Layer.mergeAll(OtlpLayerProvided, BunHttpServer.layer({ port: 3000, hostname: "0.0.0.0" })),
  Layer.provideMerge([
    AgentSessionRepository.layer,
    DocumentRepository.layer,
    ChunkRepository.layer,
    SummaryRepository.layer,
    ClarificationRepository.layer,
    OutputRepository.layer,
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
  Layer.launch,
  BunRuntime.runMain,
);

// Effect.Effect<Value, Error, Requirements>
