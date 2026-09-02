/**
 * SHIP-178 (follow-up) — the ownership-check boilerplate repeated
 * (identically, `Effect.catch(() => new AgentSessionNotFound())` after an
 * `Option.getOrThrow`/`Effect.fromOption`) across every handler that needs
 * one. That single catch collapsed two different failure modes into one
 * misleading response: a genuine AgentSessionRepository failure (DB down)
 * came back to the client as "404 session not found" — actively wrong, not
 * just imprecise, since the session may well exist. This factors ownership
 * checks into one place that gets it right once: a real store failure maps
 * to ServiceUnavailableError (503, via toServiceUnavailable), and only the
 * Option.none() "no such session for this user" case maps to
 * AgentSessionNotFound (404).
 */
import { Effect } from "effect";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { AgentSessionNotFound, ServiceUnavailableError } from "@shipwright/shared/domain/errors";
import type { AgentSession } from "@shipwright/shared/domain/types";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { toServiceUnavailable } from "./service-unavailable";

export const requireOwnedSession = (
  sessionId: AgentSessionId,
  userId: UserId,
): Effect.Effect<
  AgentSession,
  AgentSessionNotFound | ServiceUnavailableError,
  AgentSessionRepository
> =>
  Effect.gen(function* () {
    const agentSessionDb = yield* AgentSessionRepository;
    return yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId }).pipe(
      toServiceUnavailable,
      Effect.flatMap(Effect.fromOption),
      Effect.catchTag("NoSuchElementError", () => new AgentSessionNotFound()),
    );
  });
