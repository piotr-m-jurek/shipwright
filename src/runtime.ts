import { Layer, ManagedRuntime } from "effect";
import { EffectStorageAdapterService } from "./storage/index.js";

export const appMemoMap = Layer.makeMemoMapUnsafe();

export const runtime = ManagedRuntime.make(EffectStorageAdapterService.EffectStorageAdapter.layer, {
  memoMap: appMemoMap,
});
