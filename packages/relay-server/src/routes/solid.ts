import { Hono } from "hono";
import { z } from "zod";
import { exportSessionToPod } from "../solid/export.js";
import { getSession, isValidToken } from "../store/memory.js";

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
    return c.json({ error: `Solid export failed: ${err.message}` }, 500);
  }
});
