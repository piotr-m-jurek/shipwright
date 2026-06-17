import { Layer, pipe } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import path from "node:path";
import { StorageAdapter } from "../storage/index.js";
import { Api } from "./api/api.js";
import { SystemApiHandlers } from "./handlers.js";

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

const HttpServerLayer = pipe(
  HttpRouter.serve(AllRoutes),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

pipe(Layer.launch(HttpServerLayer), NodeRuntime.runMain);
