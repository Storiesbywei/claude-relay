import { scanContent, logScanEvent } from "./scanner.js";

export function scanAndGateMessage(
  content: string,
  title: string | undefined,
  protocol: string
): { allowed: boolean; warnings: string[] } {
  const contentScan = scanContent(content);
  if (contentScan.hasSensitive) {
    logScanEvent(protocol, "blocked", contentScan.warnings.join(", "));
    return { allowed: false, warnings: contentScan.warnings };
  }
  if (title) {
    const titleScan = scanContent(title);
    if (titleScan.hasSensitive) {
      logScanEvent(protocol, "blocked", `title: ${titleScan.warnings.join(", ")}`);
      return { allowed: false, warnings: titleScan.warnings };
    }
  }
  return { allowed: true, warnings: [] };
}
