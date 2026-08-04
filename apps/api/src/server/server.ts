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
import { DatabaseService } from "../db/queries.js";
import { AppDBLiveLayer } from "../db/index.js";
import { AuthorizationLayer } from "./authorization.js";
import { EmbeddingService } from "../agent/embedding-service.ts";
import { AnthropicClientLayer, OpenAiEmbeddingModelLayer } from "../agent/providers.ts";
import { AuthRouteLayer } from "./handlers/auth.ts";
import { SessionStorage } from "./handlers/session-storage.ts";
import { SessionResults } from "./handlers/session-results.ts";
import { PublicApi } from "./handlers/public.ts";
import { MessageQueue } from "../queue/index.ts";
import { JobHandlers } from "../queue/job-handlers.ts";

export const ApiLayer = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  Layer.provide([SessionStorage, SessionCompute, SessionResults, PublicApi]),
  Layer.provide(AuthorizationLayer),
  Layer.provide(DatabaseService.layer),
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
  ApiLayer,
  DocsLayer,
  StaticFilesLayer,
  CorsLayer,
);

const OtlpLayerProvided = pipe(
  OtlpLayer,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

const EmbeddingServiceLayer = EmbeddingService.layer.pipe(
  Layer.provideMerge(OpenAiEmbeddingModelLayer),
);

const JobHandlersLayer = pipe(
  JobHandlers.layer,
  Layer.provide([
    DatabaseService.layer,
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
    DatabaseService.layer,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
  ]),
  Layer.provideMerge(JobHandlersLayer),
  Layer.provideMerge(MessageQueue.layer),
  Layer.provideMerge(AppDBLiveLayer),
);

pipe(
  HttpRouter.serve(AllRoutesLayer),
  Layer.provideMerge(ServiceLayer),
  Layer.launch,
  NodeRuntime.runMain,
);

// Effect.Effect<Value, Error, Requirements>
