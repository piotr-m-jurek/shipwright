import { Schema } from "effect";

const permissionAction = ["read", "write", "manage"] as const;
type PermissionAction = (typeof permissionAction)[number];
type PermissionConfig = Record<string, ReadonlyArray<PermissionAction>>;

export type InferPermissions<T extends PermissionConfig> = {
  [K in keyof T]: T[K][number] extends PermissionAction ? `${K & string}:${T[K][number]}` : never;
}[keyof T];

export const makePermissions = <Config extends PermissionConfig>(
  config: Config,
): Array<InferPermissions<Config>> => {
  return Object.entries(config).flatMap(([domain, actions]) =>
    actions.map((action) => `${domain}:${action}` as InferPermissions<Config>),
  );
};
export const permissions = makePermissions({
  __test: ["manage", "write"],
  generatedDocuments: ["read"],
} as const);

export const Permission = Schema.Literals([...permissions]).annotate({ identifier: "Permission" });
export type Permission = typeof Permission.Type;
