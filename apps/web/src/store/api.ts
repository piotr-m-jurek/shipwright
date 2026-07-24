import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import { Api } from "@shipwright/shared/api";
import { BrowserHttpClient } from "@effect/platform-browser";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { Authorization } from "@shipwright/shared/middleware";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const AuthorizationClient = HttpApiMiddleware.layerClient(
  Authorization,
  Effect.fn(function* ({ next, request }) {
    return yield* next(request);
  }),
);
Atom.runtime.addGlobalLayer(AuthorizationClient);

const CredentialsFetchLayer = Layer.provide(
  BrowserHttpClient.layerFetch,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
);

export class ShipwrightApi extends AtomHttpApi.Service<ShipwrightApi>()(
  "shipwright/ShipwrightApi",
  {
    api: Api,
    httpClient: CredentialsFetchLayer,
  },
) {}
