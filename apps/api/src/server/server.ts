import { Effect, Layer, pipe } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { StorageAdapter } from "@shipwright/storage";
import { Api } from "@shipwright/shared/api";
import { SessionCompute } from "./handlers/session-compute";
import { ConfigService } from "@shipwright/config";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { McpTokenRepository } from "@shipwright/db/repositories/mcp-token-repository";
import { AppDBLiveLayer } from "@shipwright/db";
import { AuthorizationLayer } from "./authorization";
import { AuthRouteLayer } from "./handlers/auth";
import { SessionStorage } from "./handlers/session-storage";
import { SessionResults } from "./handlers/session-results";
import { PublicApi } from "./handlers/public";
import { McpToken } from "./handlers/mcp-token";
import { RequestLoggingMiddlewareLayer } from "../observability/http-middleware";
import { SessionDebugSseLayer } from "./handlers/session-debug-sse";
import { SessionQuestionsSseLayer } from "./handlers/session-questions-sse";

// This file defines routes and the API layer only — no infrastructure
// wiring (DB pool sizing aside, StorageAdapter/DB/repos are provided here
// only because ApiLayer needs them to be self-contained), no OTLP/Langfuse/
// job-handler composition, and no runtime bootstrap. That's main.ts's job.
// Keeping the two separate means this module has no @effect/platform-bun
// dependency anywhere in its import graph, so server.test.ts can import
// ApiLayer/AllRoutesLayer directly — vitest's test workers don't run
// inside the actual Bun binary and crash on Bun-only top-level imports.

export const ApiGroupsLayer = Layer.provide([
  SessionStorage,
  SessionCompute,
  SessionResults,
  PublicApi,
  McpToken,
]);

export const RepositoriesLayer = Layer.mergeAll(
  AgentSessionRepository.layer,
  DocumentRepository.layer,
  ChunkRepository.layer,
  SummaryRepository.layer,
  ClarificationRepository.layer,
  OutputRepository.layer,
  McpTokenRepository.layer,
);

// The base infrastructure ApiLayer needs to be self-contained (server.test.ts
// builds TestRoutes from ApiLayer alone, providing only NodeHttpServer +
// StorageAdapter.layer + ConfigService.layer — no repos/DB). Exported so
// main.ts can reuse this exact reference for JobHandlersLayer/ServiceLayer
// instead of re-listing the same layers — Effect dedups by reference
// identity, so reusing the reference is what actually guarantees a single
// DB pool/StorageAdapter instance, not just convention.
export const InfrastructureLayer = Layer.mergeAll(RepositoriesLayer, StorageAdapter.layer).pipe(
  Layer.provide(AppDBLiveLayer),
  Layer.provide(ConfigService.layer),
);

export const ApiLayer = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  ApiGroupsLayer,
  Layer.provide(AuthorizationLayer),
  Layer.provide(InfrastructureLayer),
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

export const AllRoutesLayer = Layer.mergeAll(
  AuthRouteLayer,
  SessionDebugSseLayer,
  SessionQuestionsSseLayer,
  ApiLayer,
  DocsLayer,
  CorsLayer,
  RequestLoggingMiddlewareLayer,
);
