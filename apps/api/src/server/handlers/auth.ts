import { NodeHttpServerRequest } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { auth } from "../../auth/auth.ts";

class IncomingMessageResolveError extends Schema.TaggedErrorClass<IncomingMessageResolveError>()(
  "IncomingMessageResolveError",
  { cause: Schema.Defect() },
) {}

export const AuthRouteLayer = HttpRouter.add("*", "/api/auth/*", (req) =>
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
      catch: (e) => new IncomingMessageResolveError({ cause: e }),
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
