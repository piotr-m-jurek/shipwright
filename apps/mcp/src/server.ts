import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { CurrentUser } from "@shipwright/shared/middleware";
import { ConfigService } from "@shipwright/config";
import { Effect, Layer, pipe } from "effect";
import { BriefResource, PrdResource } from "./resources";
import { QuerySessionToolkitLayer } from "./tools";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { McpAuthMiddlewareLayer } from "./auth";
import { AppDBLiveLayer } from "@shipwright/db";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { McpTokenRepository } from "@shipwright/db/repositories/mcp-token-repository";
import { EmbeddingService, HuggingFaceTeiEmbeddingModelLayerProvided } from "@shipwright/embedding";
import { OtlpLayer } from "@shipwright/observability";
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http";

// Same derivation as apps/api/src/server/server.ts's OtlpLayerProvided —
// OtlpLayer itself only requires ConfigService; OtlpTracer/OtlpMetrics need
// an HttpClient under the hood to actually send to Langfuse's OTLP endpoint.
const OtlpLayerProvided = pipe(
  OtlpLayer,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);

// StorageAdapter/S3 is not needed here: resources.ts reads outputs.content
// directly from Postgres (see Stack doc, Section 8).
const CapabilitiesLayer = Layer.mergeAll(BriefResource, PrdResource, QuerySessionToolkitLayer);

const McpHttpLayer = McpServer.layerHttp({
  name: "Shipwright MCP", // TODO: should be coming from package.json
  version: "1.0.0", // TODO: should be coming from package json
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowedOrigins: ["https://localhost:3001", "https://localhost:3002"], // TODO: no magic strings
});

// mergeAll, not one .pipe(Layer.provide(...)) into the other: BriefResource/
// PrdResource/QuerySessionToolkitLayer and McpHttpLayer each internally
// provide McpServer.layer themselves already -- they need to share that
// memoized instance (same registry), not have one nested inside the other.
//
// McpAuthMiddlewareLayer needs to be a sibling here so it's part of the same
// request-handling chain -- but note its CurrentUser "provides" is *not*
// resolved by ordinary Layer-graph type-checking (see the cast at the bottom
// of this file for why, and why that's correct rather than a workaround).
// Do NOT try Layer.provide(McpAuthMiddlewareLayer) into CapabilitiesLayer:
// its actual output type is the branded Request.From<"...", CurrentUser>,
// not bare CurrentUser, so it can never satisfy CapabilitiesLayer's
// requirement through ordinary Layer composition regardless of nesting.
const AllRoutesLayer = Layer.mergeAll(CapabilitiesLayer, McpHttpLayer, McpAuthMiddlewareLayer);

// The raw (non-"Provided") HuggingFaceTeiEmbeddingModelLayer still needs
// ConfigService + HttpClient -- HuggingFaceTeiEmbeddingModelLayerProvided is
// the self-contained variant (already bakes both in), matching how
// apps/api/src/server/server.ts wires the identical layer.
const EmbeddingServiceLayer = EmbeddingService.layer.pipe(
  Layer.provideMerge(HuggingFaceTeiEmbeddingModelLayerProvided),
);

// AppDBLiveLayer already provides ConfigService internally -- nothing else
// here needs it supplied separately. McpTokenRepository is needed by
// McpAuthMiddlewareLayer (auth.ts), not by the capabilities -- it still
// belongs here since this is the one shared "infra" bag the whole
// AllRoutesLayer merge draws from (see ServiceLayer/FullyComposedLayer below).
const InfraLayer = Layer.mergeAll(
  AgentSessionRepository.layer,
  ChunkRepository.layer,
  OutputRepository.layer,
  McpTokenRepository.layer,
  EmbeddingServiceLayer,
).pipe(Layer.provideMerge(AppDBLiveLayer));

const ServiceLayer = pipe(
  Layer.mergeAll(OtlpLayerProvided, BunHttpServer.layer({ port: 3002, hostname: "0.0.0.0" })),
  Layer.provideMerge(InfraLayer),
);

const FullyComposedLayer = HttpRouter.serve(AllRoutesLayer, {
  middleware: HttpMiddleware.searchParamsParser,
}).pipe(Layer.provideMerge(ServiceLayer));

/**
 * CurrentUser is the one remaining "unresolved" requirement the type checker
 * reports here, and it cannot be resolved through ordinary Layer composition
 * -- this is expected, not a bug to route around with a real Layer.provide.
 *
 * McpAuthMiddlewareLayer supplies CurrentUser dynamically, per request, by
 * wrapping request handling with Effect.provideService -- it is not a static
 * service with a Layer that could satisfy a Layer-graph dependency. Tool.make's
 * `dependencies` option (tools.ts) and McpServer.resource's `content` function
 * (resources.ts) both require their per-call service requirements to be
 * statically resolvable via Layer.provide -- there is no supported way in
 * this version of the MCP module to declare "this will be supplied ambiently
 * by unrelated per-request middleware" in a way the type checker can verify.
 *
 * The runtime behavior is nonetheless correct, verified empirically: Effect's
 * Effect.provideContext/Effect.provide only narrow the *specific* tags they
 * define -- they do not strip other already-ambient services from the fiber.
 * So CurrentUser, injected by McpAuthMiddlewareLayer around each request,
 * genuinely reaches BriefResource/PrdResource/QuerySessionToolkitLayer's
 * handlers despite McpServer's own internal build-time-captured context
 * wrapping around them (see tools.ts's module doc comment for the full
 * explanation and how this was verified).
 *
 * Do NOT "fix" this compile error by Layer.provide-ing a real or dummy
 * CurrentUser value anywhere above this line: resource/tool registration
 * captures its service context exactly once, at Layer-build time (server
 * startup, before any request exists). A value provided there would be
 * captured permanently and would shadow the real per-request user for every
 * future request -- silently breaking the ownership check for every caller,
 * not just failing loudly. This cast changes nothing about what value is
 * actually used at runtime; it only removes a requirement the type checker
 * cannot otherwise discharge.
 *
 * Narrowly scoped to exactly the one gap: only CurrentUser is asserted away
 * from R -- E is preserved as whatever it actually is (not widened to
 * `unknown`), so a genuine new unresolved dependency introduced later by a
 * change elsewhere still surfaces as a real compile error here, instead of
 * being silently absorbed by this escape hatch.
 */
const dischargeCurrentUserRequirement = <E>(
  effect: Effect.Effect<never, E, CurrentUser>,
): Effect.Effect<never, E, never> => effect as unknown as Effect.Effect<never, E, never>;

BunRuntime.runMain(dischargeCurrentUserRequirement(Layer.launch(FullyComposedLayer)));
