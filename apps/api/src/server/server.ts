import { Effect, Layer, pipe } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer, NodeHttpServerRequest, NodeRuntime } from "@effect/platform-node";
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
import { EmbeddingService } from "../agent/embedding-service.ts";
import { OpenAiEmbeddingModel } from "@effect/ai-openai";
import { AnthropicClientLayer, OpenAiClientLayer } from "../agent/providers.ts";

export const ApiRoute = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }),
  Layer.provide([SystemApiHandlers, PublicApiHandlers]),
  // Layer.provideMerge(AnthropicClientLayer),
  Layer.provideMerge(AuthorizationLayer),
);

const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" });

const StaticFiles = HttpStaticServer.layer({
  root: path.resolve("dist"),
  spa: true,
  index: "index.html",
});

const AuthLayer = HttpRouter.add("*", "/api/auth/*", (req) =>
  Effect.gen(function* () {
    const incomingMessage = NodeHttpServerRequest.toIncomingMessage(req);
    const url = new URL(req.url, "http://localhost:3000");

    const body = yield* Effect.tryPromise({
      try: () =>
        new Promise<Buffer | null>((resolve, reject) => {
          const chunks: Buffer[] = [];
          incomingMessage.on("data", (chunk: Buffer) => chunks.push(chunk));
          incomingMessage.on("end", () =>
            resolve(chunks.length > 0 ? Buffer.concat(chunks) : null),
          );
          incomingMessage.on("error", reject);
        }),
      catch: (e) => e as Error,
    });

    const webRequest = new Request(url, {
      method: incomingMessage.method ?? "GET",
      headers: incomingMessage.headers as HeadersInit,
      body: body === null ? null : Uint8Array.from(body),
    });

    const response = yield* Effect.promise(() => auth.handler(webRequest));
    return HttpServerResponse.fromWeb(response);
  }),
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
        HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins, credentials: true }),
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

const OpenAiEmbeddingModelLayer = pipe(
  OpenAiEmbeddingModel.model("text-embedding-3-small", { dimensions: 1536 }),
  Layer.provide(OpenAiClientLayer),
);

const EmbeddingServiceLayer = EmbeddingService.layer.pipe(
  Layer.provideMerge(OpenAiEmbeddingModelLayer),
);

const ServiceLayer = pipe(
  Layer.mergeAll(
    DatabaseService.layer,
    OtlpLayerProvided,
    EmbeddingServiceLayer,
    /* , MessageQueue.layer */
  ),
  Layer.provideMerge(AppDBLayer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 })),
  Layer.provideMerge(StorageAdapter.layer),
  Layer.provideMerge(ConfigService.layer),
);

const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(Layer.provide(ServiceLayer));

// INFO: known issue with static files, will be removed when moved to monorepo
NodeRuntime.runMain(Layer.launch(HttpServerLayer));
