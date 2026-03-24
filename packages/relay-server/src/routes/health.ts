import { Hono } from "hono";
import { getSessionCount } from "../store/memory.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    sessions: getSessionCount(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});
