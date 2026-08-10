import type { UserId } from "@shipwright/shared/domain/ids";
import { Context, Effect } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { HttpApiError } from "effect/unstable/httpapi";
import { Permission } from "./permission";

// DUMMY, for later implementation

interface Interface {
  id: UserId;
  email: string;
  name: string;
  permissions: Set<Permission>;
}

export class CurrentUser extends Context.Service<CurrentUser, Interface>()("CurrentUser") {}

// DUMMY, for later implementation

type Policy<Error = never, Requirement = never> = Effect.Effect<
  void,
  HttpApiError.Forbidden | Error,
  CurrentUser | Requirement
>;

export const policy = <Errors, Requirements>(
  predicate: (user: CurrentUser["Service"]) => Effect.Effect<boolean, Errors, Requirements>,
): Policy<Errors, Requirements> =>
  Effect.flatMap(CurrentUser, (user) =>
    Effect.flatMap(predicate(user), (result) =>
      result ? Effect.void : Effect.fail(new HttpApiError.Forbidden()),
    ),
  );

export const withPolicy =
  <E, R>(policy: Policy<E, R>) =>
  <A, E2, R2>(self: Effect.Effect<A, E2, R2>) =>
    Effect.andThen(policy, self);

export const all = <E, R>(...policies: NonEmptyReadonlyArray<Policy<E, R>>): Policy<E, R> =>
  Effect.all(policies, { concurrency: 2, discard: true });

export const any = <E, R>(...policies: NonEmptyReadonlyArray<Policy<E, R>>): Policy<E, R> =>
  Effect.firstSuccessOf(policies);

export const permission = (requiredPermission: Permission): Policy =>
  policy((user) => Effect.succeed(user.permissions.has(requiredPermission)));
