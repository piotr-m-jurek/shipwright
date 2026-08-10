import type { UserId } from "@shipwright/shared/domain/ids";
import { Context, Effect, pipe, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { HttpApiError } from "effect/unstable/httpapi";

const permissionAction = ["read", "write", "manage"] as const;
type PermissionAction = (typeof permissionAction)[number];
type PermissionConfig = Record<string, ReadonlyArray<PermissionAction>>;

export type InferPermissions<T extends PermissionConfig> = {
  [K in keyof T]: T[K][number] extends PermissionAction ? `${K & string}:${T[K][number]}` : never;
}[keyof T];

export const makePermissions = <T extends PermissionConfig>(
  config: T,
): Array<InferPermissions<T>> => {
  return Object.entries(config).flatMap(([domain, actions]) =>
    actions.map((action) => `${domain}:${action}` as InferPermissions<T>),
  );
};
const permissions = makePermissions({
  __test: ["manage", "write"],
  generatedDocuments: ["read"],
} as const);

const Permission = Schema.Literals([...permissions]).annotate({ identifier: "Permission" });
type Permission = typeof Permission.Type;

interface Interface {
  id: UserId;
  email: string;
  name: string;
  permissions: Set<Permission>;
}

export class CurrentUser extends Context.Service<CurrentUser, Interface>()("CurrentUser") {}

type Policy<Error = never, Requirement = never> = Effect.Effect<
  void,
  HttpApiError.Forbidden | Error,
  CurrentUser | Requirement
>;

export const policy = <E, R>(
  predicate: (user: CurrentUser["Service"]) => Effect.Effect<boolean, E, R>,
): Policy<E, R> =>
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

const permission = (requiredPermission: Permission): Policy =>
  policy((user) => Effect.succeed(user.permissions.has(requiredPermission)));

const program = Effect.fn("program")(
  function* () {
    return yield* Effect.succeed("yuhu!" as const);
  },
  withPolicy(permission("generatedDocuments:read")),
);
