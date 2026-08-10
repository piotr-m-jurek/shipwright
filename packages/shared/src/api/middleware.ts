import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi";
import type { UserId } from "../domain/ids";

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

interface Interface {
  id: UserId;
  email: string;
  name: string;
}

export class CurrentUser extends Context.Service<CurrentUser, Interface>()("CurrentUser") {}

export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentUser }
>()("Authorization", {
  requiredForClient: true,
  security: { cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "better-auth.session_token" }) },
  error: Unauthorized,
}) {}
