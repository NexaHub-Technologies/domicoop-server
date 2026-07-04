import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { logger } from "@bogeychan/elysia-logger";
import { v1Routes } from "@/routes/v1";
import { NotificationService } from "@/services/notificationService";

const app = new Elysia()
  .use(
    cors({
      origin: [process.env.CLIENT_ADMIN_ORIGIN!, "http://localhost:3001", /^exp:\/\//],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .use(logger({ level: "info" }))
  .use(swagger({ documentation: { info: { title: "DOMICOOP API", version: "2.0.0" } } }))

  // Root route - API info
  .get("/", () => ({
    name: "DOMICOOP API",
    version: "2.0.0",
    status: "running",
    documentation: "/swagger",
    health: "/health",
    base_path: "/v1",
  }))

  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  }))

  // Application routes
  .use(v1Routes)

  .onError(({ code, error, set }) => {
    const err = error as Error;
    console.error(`[${code}]`, err.message);
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: "Validation failed", details: err.message };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Route not found" };
    }
    const status = typeof set.status === "number" && set.status >= 400 ? set.status : 500;
    set.status = status;
    return { error: err.message ?? "Internal server error" };
  })

  .listen(process.env.PORT ?? 3000);

// WebSocket publishing uses Bun's in-process pub/sub — a shared broker
// (e.g. Redis) would be needed before running multiple instances.
if (app.server) {
  NotificationService.getInstance().setServer(app.server);
}

console.log(`✓ DOMICOOP API running on http://localhost:${app.server?.port}`);
export type App = typeof app;
