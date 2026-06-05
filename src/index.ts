import { Hono } from "hono";
import { api } from "./api/index.js";

const app = new Hono();

app.get("/", (c) => c.text("Hello Hono!"));
api.get("/health", (c) => c.text("Healthy!"));
app.route("/api", api);

export default app;
