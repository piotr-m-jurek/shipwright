import { Clock, Effect } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { randomUUID } from "node:crypto";

/**
 * Global HTTP middleware that:
 *  - Generates a requestId (UUID v4) for every inbound request
 *  - Echoes it as `x-request-id` on the response
 *  - Attaches it to every downstream log line via `Effect.annotateLogs`
 *  - Attaches it as a span attribute
 *  - Logs method, path, status, and durationMs on completion
 *
 * Session ID propagation is intentionally absent here. The HTTP trace span
 * is a short-lived trigger; all meaningful work (LLM calls, extraction,
 * writing) runs in queue jobs where Spans.session() is already applied via
 * withJobSpan in job-handlers.ts.
 */
const requestLoggingMiddleware = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestId =
      typeof request.headers["x-request-id"] === "string"
        ? request.headers["x-request-id"]
        : randomUUID();

    const startMs = yield* Clock.currentTimeMillis;

    // Name the trace for Langfuse — fixes "Unknown" traces in the Langfuse UI.
    // Uses "{METHOD} {path}" so each route type groups cleanly.
    // Also propagate requestId for cross-system correlation.
    yield* Effect.annotateCurrentSpan({
      "http.request_id": requestId,
      "langfuse.trace.name": `${request.method} ${request.url}`,
    });

    // Register a pre-response handler to echo requestId header
    yield* HttpEffect.appendPreResponseHandler((_req, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "x-request-id", requestId)),
    );

    const exit = yield* Effect.exit(httpApp);

    const endMs = yield* Clock.currentTimeMillis;
    const durationMs = endMs - startMs;

    const status = exit._tag === "Success" ? exit.value.status : 500;

    yield* Effect.logInfo("HTTP request").pipe(
      Effect.annotateLogs({
        "http.method": request.method,
        "http.path": request.url,
        "http.status": status,
        "http.duration_ms": durationMs,
        "http.request_id": requestId,
      }),
    );

    return yield* exit;
  });

export const RequestLoggingMiddlewareLayer = HttpRouter.middleware(requestLoggingMiddleware, {
  global: true,
});
