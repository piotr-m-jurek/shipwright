import { Effect, Layer, pipe } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import path from "node:path";
import { StorageAdapter } from "../storage/index.js";
import { Api } from "./api/api.js";
import { SystemApiHandlers } from "./handlers.js";
import { ConfigService } from "../config.js";
import { DatabaseService } from "../db/queries.js";

export const ApiRoute = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }),
  Layer.provide([SystemApiHandlers]),
);

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

const StaticFiles = HttpStaticServer.layer({
  root: path.resolve("dist"),
  spa: true,
  index: "index.html",
});

const AllRoutes = Layer.mergeAll(ApiRoute, DocsRoute, StaticFiles);

const ServiceLayer = pipe(
  Layer.mergeAll(DatabaseService.layer),
  Layer.provideMerge(StorageAdapter.layer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 })),
);

const HttpServerLayer = pipe(
  HttpRouter.serve(AllRoutes),
  Layer.provide(ServiceLayer), //
);

// INFO: known issue with static files, will be removed when moved to monorepo
NodeRuntime.runMain(Layer.launch(HttpServerLayer) as Effect.Effect<never, never, never>);
