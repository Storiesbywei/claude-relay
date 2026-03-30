/** Configuration for exporting to a Solid Pod */
export interface SolidExportConfig {
  /** The user's Pod URL (e.g., "https://pod.example/alice/") */
  podUrl: string;
  /** OIDC issuer for authentication */
  oidcIssuer: string;
  /** Client ID (from static registration) */
  clientId: string;
  /** Client secret */
  clientSecret: string;
  /** Container path within the Pod (default: "relay-sessions/") */
  containerPath?: string;
}

/** Result of a Solid export operation */
export interface SolidExportResult {
  containerUrl: string;
  messageCount: number;
  metadataUrl: string;
  exportedAt: string;
}

/** Relay vocabulary namespace */
export const RELAY_VOCAB = "https://vocab.claude-relay.dev/" as const;

/** Message type → RDF class mapping */
export const MESSAGE_TYPE_TO_RDF_CLASS: Record<string, string> = {
  architecture: "ArchitectureMessage",
  "api-docs": "ApiDocsMessage",
  patterns: "PatternsMessage",
  conventions: "ConventionsMessage",
  question: "QuestionMessage",
  answer: "AnswerMessage",
  context: "ContextMessage",
  insight: "InsightMessage",
  task: "TaskMessage",
  file_tree: "FileTreeMessage",
  file_change: "FileChangeMessage",
  file_read: "FileReadMessage",
  terminal: "TerminalMessage",
  status_update: "StatusUpdateMessage",
};
