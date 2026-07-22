import { Effect, Layer, pipe } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import path from "node:path";
import { StorageAdapter } from "../storage/index.js";
import { Api } from "@shipwright/shared/api.js";
import { PublicApiHandlers, SystemApiHandlers } from "./handlers.js";
import { ConfigService } from "../config/config.js";
import { OtlpLayer } from "../observability/observability.js";
import { DatabaseService } from "../db/queries.js";
import { AppDBLayer } from "../db/index.js";
import { auth } from "../auth/auth.js";
import { AuthorizationLayer } from "./authorization.js";

export const ApiRoute = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }),
  Layer.provide([SystemApiHandlers, PublicApiHandlers]),
  Layer.provide(AuthorizationLayer),
);

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

const StaticFiles = HttpStaticServer.layer({
  root: path.resolve("dist"),
  spa: true,
  index: "index.html",
});

const AuthLayer = HttpRouter.add("*", "/api/auth/*", (req) =>
  Effect.promise(() => auth.handler(req.source as Request)).pipe(
    Effect.map(HttpServerResponse.fromWeb),
  ),
);
const AllRoutes = pipe(
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ConfigService;
      return Layer.mergeAll(
        AuthLayer,
        ApiRoute,
        DocsRoute,
        StaticFiles,
        HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins }),
      );
    }),
  ),
  Layer.provide(ConfigService.layer),
);

const OtlpLayerProvided = pipe(
  OtlpLayer,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

const ServiceLayer = pipe(
  Layer.mergeAll(DatabaseService.layer, OtlpLayerProvided /* , MessageQueue.layer */),
  Layer.provideMerge(AppDBLayer),
  Layer.provideMerge(StorageAdapter.layer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.provideMerge(ConfigService.layer),
);

const HttpServerLayer = pipe(HttpRouter.serve(AllRoutes), Layer.provide(ServiceLayer));

// INFO: known issue with static files, will be removed when moved to monorepo
NodeRuntime.runMain(Layer.launch(HttpServerLayer) as Effect.Effect<never, never, never>);
