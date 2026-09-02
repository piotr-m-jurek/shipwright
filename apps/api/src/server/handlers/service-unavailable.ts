/**
 * SHIP-178 — a typed alternative to `Effect.orDie` for repository/store
 * failures in HttpApiBuilder handlers.
 *
 * `Effect.orDie` collapses a real, typed infra error (a DB query failing,
 * the job store being unreachable) into a defect — an unhandled defect
 * reaches HttpApiBuilder's fallback as a generic 500, indistinguishable
 * from an actual bug. A client can't tell "you hit a bug" from "the store
 * is temporarily unavailable, retry me." `ServiceUnavailableError` (503)
 * already exists for exactly this (previously only wired to the
 * health-check endpoint) — this maps any repository/store failure to it,
 * logging the real cause server-side first (a defect would have been
 * logged automatically by the runtime; a typed error is not, so this
 * preserves that visibility explicitly).
 */
import { Effect } from "effect";
import { ServiceUnavailableError } from "@shipwright/shared/domain/errors";

export const toServiceUnavailable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ServiceUnavailableError, R> =>
  effect.pipe(
    Effect.tapError((cause) =>
      Effect.logError("[toServiceUnavailable] backing service call failed", cause),
    ),
    Effect.mapError(
      () => new ServiceUnavailableError({ message: "A backing service is temporarily unavailable" }),
    ),
  );
