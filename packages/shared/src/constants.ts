export const RELAY_PORT = 4190;
export const RELAY_URL_DEFAULT = `http://localhost:${RELAY_PORT}`;

export const LIMITS = {
  MAX_MESSAGE_SIZE: 102_400,    // 100KB
  MAX_MESSAGES_PER_SESSION: 200,
  MAX_SESSIONS: 50,
  MAX_PARTICIPANTS: 10,
  MAX_TITLE_LENGTH: 200,
  MAX_TAGS: 20,
  MAX_TAG_LENGTH: 50,
  MAX_REFERENCES: 50,
  RATE_LIMIT_PER_MINUTE: 30,
  DEFAULT_TTL_MINUTES: 60,
  MAX_TTL_MINUTES: 1440,       // 24 hours
  TTL_SWEEP_INTERVAL_MS: 60_000,
} as const;

export const MESSAGE_TYPES = [
  "architecture",
  "api-docs",
  "patterns",
  "conventions",
  "question",
  "answer",
  "context",
  "insight",
  "task",
  // Phase 3: workspace awareness
  "file_tree",      // worker sends project structure snapshot
  "file_change",    // worker sends a file diff/edit
  "file_read",      // worker shares file contents
  "terminal",       // worker shares terminal output
  "status_update",  // worker status (idle, reading, writing, testing)
] as const;

// Patterns that suggest sensitive content
export const SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})/,              // OpenAI/Anthropic keys
  /\b(ghp_[a-zA-Z0-9]{36,})/,             // GitHub PATs
  /\b(AKIA[A-Z0-9]{16})/,                 // AWS access keys
  /\b(xox[bpsa]-[a-zA-Z0-9-]+)/,          // Slack tokens
  /password\s*[:=]\s*["'][^"']+["']/i,     // password assignments
  /secret\s*[:=]\s*["'][^"']+["']/i,       // secret assignments
  /api[_-]?key\s*[:=]\s*["'][^"']+["']/i,  // api key assignments
  /\/Users\/[a-zA-Z0-9_-]+\//,            // macOS absolute paths
  /\/home\/[a-zA-Z0-9_-]+\//,             // Linux absolute paths
  /[A-Z]:\\/,                              // Windows absolute paths
];
