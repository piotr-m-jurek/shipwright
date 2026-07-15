import { AtomHttpApi } from "effect/unstable/reactivity";
import { Api } from "@shipwright/shared/api";
import { BrowserHttpClient } from "@effect/platform-browser";

export class ShipwrightApi extends AtomHttpApi.Service<ShipwrightApi>()(
  "shipwright/ShipwrightApi",
  {
    api: Api,
    httpClient: BrowserHttpClient.layerFetch,
  },
) {}
