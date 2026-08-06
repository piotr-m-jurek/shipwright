import { Effect, Layer, pipe } from "effect";
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import path from "node:path";
import { StorageAdapter } from "../storage/index.js";
import { Api } from "@shipwright/shared/api.js";
import { SessionCompute } from "./handlers/session-compute.ts";
import { ConfigService } from "../config/config.js";
import { OtlpLayer } from "../observability/observability.js";
import { AgentSessionRepository } from "../db/repositories/agent-session-repository.ts";
import { DocumentRepository } from "../db/repositories/document-repository.ts";
import { ChunkRepository } from "../db/repositories/chunk-repository.ts";
import { SummaryRepository } from "../db/repositories/summary-repository.ts";
import { ClarificationRepository } from "../db/repositories/clarification-repository.ts";
import { OutputRepository } from "../db/repositories/output-repository.ts";
import { AppDBLiveLayer } from "../db/index.js";
import { AuthorizationLayer } from "./authorization.js";
import { EmbeddingService } from "../agent/embedding-service.ts";
import { AnthropicClientLayer, HuggingFaceTeiEmbeddingModelLayerProvided } from "../agent/providers.ts";
import { AuthRouteLayer } from "./handlers/auth.ts";
import { SessionStorage } from "./handlers/session-storage.ts";
import { SessionResults } from "./handlers/session-results.ts";
import { PublicApi } from "./handlers/public.ts";
import { MessageQueue } from "../queue/index.ts";
import { JobHandlers } from "../queue/job-handlers.ts";
import { RequestLoggingMiddlewareLayer } from "../observability/http-middleware.ts";
import { SessionDebugSseLayer } from "./handlers/session-debug-sse.ts";

export const ApiLayer = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  Layer.provide([SessionStorage, SessionCompute, SessionResults, PublicApi]),
  Layer.provide(AuthorizationLayer),
  Layer.provide([AgentSessionRepository.layer, DocumentRepository.layer, ChunkRepository.layer, SummaryRepository.layer, ClarificationRepository.layer, OutputRepository.layer]),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(AppDBLiveLayer),
  Layer.provide(ConfigService.layer),
);

const DocsLayer = HttpApiScalar.layer(Api, { path: "/docs" });

const StaticFilesLayer = HttpStaticServer.layer({
  root: path.resolve("dist"),
  spa: true,
  index: "index.html",
});

const CorsLayer = pipe(
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins, credentials: true });
  }),
  Effect.mapError(Effect.orDie),
  Layer.unwrap,
  Layer.provide(ConfigService.layer),
);

const AllRoutesLayer = Layer.mergeAll(
  AuthRouteLayer,
  SessionDebugSseLayer,
  ApiLayer,
  DocsLayer,
  StaticFilesLayer,
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

const JobHandlersLayer = pipe(
  JobHandlers.layer,
  Layer.provide([
    AgentSessionRepository.layer, DocumentRepository.layer, ChunkRepository.layer, SummaryRepository.layer, ClarificationRepository.layer, OutputRepository.layer,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
    MessageQueue.layer,
  ]),
  Layer.provide(AppDBLiveLayer),
);

const ServiceLayer = pipe(
  Layer.mergeAll(OtlpLayerProvided, NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.provideMerge([
    AgentSessionRepository.layer, DocumentRepository.layer, ChunkRepository.layer, SummaryRepository.layer, ClarificationRepository.layer, OutputRepository.layer,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
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
    yield* Effect.addFinalizer(() =>
      Effect.logInfo("Server shutting down"),
    );
  }),
);

pipe(
  HttpRouter.serve(Layer.merge(AllRoutesLayer, StartupLayer)),
  Layer.provideMerge(ServiceLayer),
  Layer.launch,
  NodeRuntime.runMain,
);

// Effect.Effect<Value, Error, Requirements>
