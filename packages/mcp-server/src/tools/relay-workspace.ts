import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as client from "../client/relay-client.js";
import { getActiveSession } from "../state.js";

// Common directories/files to skip
const IGNORE_PATTERNS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  ".next", ".nuxt", "dist", "build", ".cache", ".DS_Store",
  "coverage", ".nyc_output", ".pytest_cache", ".mypy_cache",
  "target", "*.pyc", ".env", ".env.local",
]);

function shouldIgnore(name: string): boolean {
  return IGNORE_PATTERNS.has(name) || name.startsWith(".");
}

async function scanDirectory(dir: string, prefix = "", depth = 0, maxDepth = 4): Promise<string[]> {
  if (depth > maxDepth) return [`${prefix}...`];

  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const lines: string[] = [];

  try {
    const entries = await readdir(dir);
    const sorted = entries.filter(e => !shouldIgnore(e)).sort((a, b) => {
      // Directories first
      return a.localeCompare(b);
    });

    for (const entry of sorted) {
      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          lines.push(`${prefix}${entry}/`);
          const children = await scanDirectory(fullPath, prefix + "  ", depth + 1, maxDepth);
          lines.push(...children);
        } else {
          lines.push(`${prefix}${entry}`);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    lines.push(`${prefix}(cannot read directory)`);
  }

  return lines;
}

export function registerWorkspaceTool(server: McpServer) {
  server.tool(
    "relay_share_workspace",
    "Scan the current project directory and share the file tree with the relay session. Also sends a summary of the project (README, package.json, etc). Call this after joining a session so the director can see your workspace.",
    {
      session_id: z.string().uuid().describe("Session to share workspace with"),
      project_dir: z.string().describe("Absolute path to the project root directory"),
      depth: z.number().optional().default(4).describe("Max directory depth to scan (default 4)"),
      include_summary: z.boolean().optional().default(true).describe("Include README/package.json summary"),
    },
    async ({ session_id, project_dir, depth, include_summary }) => {
      const session = getActiveSession(session_id);
      if (!session) {
        return {
          content: [{
            type: "text" as const,
            text: `Not connected to session ${session_id}. Use relay_join_session first.`,
          }],
          isError: true,
        };
      }

      try {
        const { basename } = await import("node:path");
        const { readFile } = await import("node:fs/promises");
        const projectName = basename(project_dir);

        // 1. Scan and send file tree
        const treeLines = await scanDirectory(project_dir, "", 0, depth);
        const treeContent = `${projectName}/\n${treeLines.join("\n")}`;

        await client.sendMessage(session_id, session.token, {
          type: "file_tree",
          content: treeContent,
        });

        // 2. Optionally send project summary
        if (include_summary) {
          const summaryParts: string[] = [`# Project: ${projectName}\n`];

          // Try reading key files
          const summaryFiles = [
            { name: "README.md", label: "README" },
            { name: "CLAUDE.md", label: "Claude Instructions" },
            { name: "package.json", label: "package.json" },
            { name: "pyproject.toml", label: "pyproject.toml" },
            { name: "Cargo.toml", label: "Cargo.toml" },
          ];

          for (const { name, label } of summaryFiles) {
            try {
              const content = await readFile(`${project_dir}/${name}`, "utf-8");
              // Truncate long files
              const truncated = content.length > 3000
                ? content.slice(0, 3000) + "\n\n... (truncated)"
                : content;
              summaryParts.push(`## ${label}\n\`\`\`\n${truncated}\n\`\`\``);
            } catch {
              // File doesn't exist, skip
            }
          }

          if (summaryParts.length > 1) {
            await client.sendMessage(session_id, session.token, {
              type: "context",
              title: `Workspace: ${projectName}`,
              content: summaryParts.join("\n\n"),
            });
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: [
              `Workspace shared with session!`,
              ``,
              `Sent file tree (${treeLines.length} entries, depth ${depth})`,
              include_summary ? `Sent project summary (README, config files)` : ``,
              ``,
              `The director can now see your project structure in the dashboard.`,
              `Use relay_send with type "file_change" to share edits as you work.`,
            ].filter(Boolean).join("\n"),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to share workspace: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );
}
