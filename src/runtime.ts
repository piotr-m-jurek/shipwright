import { Layer, ManagedRuntime } from "effect";
import { StorageAdapter } from "./storage/index.js";

export const appMemoMap = Layer.makeMemoMapUnsafe();

export const runtime = ManagedRuntime.make(StorageAdapter.layer, {
  memoMap: appMemoMap,
});
