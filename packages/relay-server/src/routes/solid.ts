import { Hono } from "hono";
import { z } from "zod";
import { exportSessionToPod } from "../solid/export.js";
import { getSession } from "../store/sqlite.js";

export const solidRoutes = new Hono();

const SolidExportRequestSchema = z.object({
  pod_url: z.string().url(),
  oidc_issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  container_path: z.string().optional(),
});

// POST /solid/:session_id/export — export session to Solid Pod
solidRoutes.post("/:session_id/export", async (c) => {
  const sessionId = c.req.param("session_id");
  const session = getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Only the session creator can export
  const token = c.get("token") as string;
  if (token !== session.creatorToken) {
    return c.json({ error: "Only the session creator can export to Solid Pod" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = SolidExportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid Solid configuration", details: parsed.error.issues }, 400);
  }

  try {
    const result = await exportSessionToPod(sessionId, {
      podUrl: parsed.data.pod_url,
      oidcIssuer: parsed.data.oidc_issuer,
      clientId: parsed.data.client_id,
      clientSecret: parsed.data.client_secret,
      containerPath: parsed.data.container_path,
    });
    return c.json(result, 201);
  } catch (err: any) {
    // Sanitize error message — never leak client_secret in responses
    const safeMessage = (err.message || "Unknown error")
      .replace(parsed.data.client_secret, "[REDACTED]");

    // Distinguish network errors (Pod unreachable) from auth/logic errors
    const isNetworkError =
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      err.cause?.code === "ECONNREFUSED" ||
      err.cause?.code === "ENOTFOUND" ||
      safeMessage.includes("fetch failed");

    if (isNetworkError) {
      return c.json(
        { error: `Solid Pod unreachable at ${parsed.data.pod_url}. Is the Pod server running?` },
        502
      );
    }

    console.error(`[solid] Export failed for session ${sessionId}: ${safeMessage}`);
    return c.json({ error: `Solid export failed: ${safeMessage}` }, 500);
  }
});
