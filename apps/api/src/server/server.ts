import { Effect, Layer, pipe } from "effect";
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import path from "node:path";
import { StorageAdapter } from "../storage/index.js";
import { Api } from "@shipwright/shared/api.js";
import {
  PublicApiHandlers,
  SessionComputationHandlers,
  SessionResultsHandlers,
  SessionStorageHandlers,
} from "./handlers/handlers.js";
import { ConfigService } from "../config/config.js";
import { OtlpLayer } from "../observability/observability.js";
import { DatabaseService } from "../db/queries.js";
import { AppDBLayer } from "../db/index.js";
import { AuthorizationLayer } from "./authorization.js";
import { EmbeddingService } from "../agent/embedding-service.ts";
import { AnthropicClientLayer, OpenAiEmbeddingModelLayer } from "../agent/providers.ts";
import { AuthRouteLayer } from "./handlers/auth.ts";

export const ApiLayer = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  Layer.provide([
    SessionStorageHandlers,
    SessionComputationHandlers,
    SessionResultsHandlers,
    PublicApiHandlers,
  ]),
  Layer.provide(AuthorizationLayer),
  Layer.provide(DatabaseService.layer),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(AppDBLayer.pipe(Layer.provide(ConfigService.layer))),
  Layer.provide(ConfigService.layer),
);

const DocsLayer = HttpApiScalar.layer(Api, { path: "/docs" });

const StaticFilesLayer = HttpStaticServer.layer({
  root: path.resolve("dist"),
  spa: true,
  index: "index.html",
});

const AllRoutesLayer = pipe(
  ConfigService,
  Effect.map((config) =>
    Layer.mergeAll(
      AuthRouteLayer,
      ApiLayer,
      DocsLayer,
      StaticFilesLayer,
      HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins, credentials: true }),
    ),
  ),
  Layer.unwrap,
  Layer.provide(ConfigService.layer),
);

const OtlpLayerProvided = pipe(
  OtlpLayer,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

const EmbeddingServiceLayer = EmbeddingService.layer.pipe(
  Layer.provideMerge(OpenAiEmbeddingModelLayer),
);

const ServiceLayer = pipe(
  Layer.mergeAll(
    OtlpLayerProvided,
    EmbeddingServiceLayer,
    AnthropicClientLayer,
    StorageAdapter.layer,
    NodeHttpServer.layer(createServer, { port: 3000 }),
  ),
  Layer.provideMerge(DatabaseService.layer), // merges DatabaseService output, needs DB
  Layer.provideMerge(AppDBLayer.pipe(Layer.provide(ConfigService.layer))), // provides DB to DatabaseService
);

const HttpServerLayer = HttpRouter.serve(AllRoutesLayer).pipe(Layer.provideMerge(ServiceLayer));

NodeRuntime.runMain(Layer.launch(HttpServerLayer));
