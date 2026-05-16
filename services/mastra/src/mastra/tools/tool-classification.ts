/**
 * Classifies Composio tool names as read-only or write operations.
 * Write tools get `requireApproval: true` for human-in-the-loop safety.
 *
 * Convention: Composio tool names follow TOOLKIT_VERB_NOUN pattern
 * e.g., GOOGLESHEETS_BATCH_GET, GOOGLESHEETS_ADD_SHEET, GMAIL_CREATE_DRAFT
 *
 * Copied verbatim from the Clarilo reference codebase (Bet 10) — the
 * only adaptation is the docstring example, swapped from Gmail to
 * Google Sheets to match this project's primary toolkit. The classifier
 * itself is unchanged because the read-verb taxonomy is provider-stable.
 */

/**
 * Verb segments that indicate READ-ONLY operations (no approval needed).
 * This is an explicit allow-list — anything not matching defaults to write (fail-safe).
 */
const READ_VERBS = new Set([
  "FETCH",
  "LIST",
  "GET",
  "SEARCH",
  "FIND",
  "CHECK",
  "QUERY",
  "RETRIEVE",
  "LOOKUP",
  "VIEW",
  "READ",
]);

/**
 * Determines if a Composio tool name represents a write/destructive operation.
 * Returns true (needs approval) for write verbs and unknown verbs (fail-safe).
 *
 * Examples:
 *   GOOGLESHEETS_BATCH_GET    → "BATCH"/"GET" — GET matches → false (read)
 *   GOOGLESHEETS_ADD_SHEET    → "ADD"/"SHEET" — neither matches → true (write)
 *   GOOGLESHEETS_BATCH_UPDATE → "BATCH"/"UPDATE" — neither matches → true (write)
 *   GMAIL_CREATE_EMAIL_DRAFT  → "CREATE"/... — none matches → true (write)
 *   GMAIL_FETCH_EMAILS        → "FETCH" matches → false (read)
 */
export function isWriteTool(toolName: string): boolean {
  const parts = toolName.toUpperCase().split("_");
  for (const part of parts) {
    if (READ_VERBS.has(part)) return false;
  }
  // Unknown verb — fail-safe: require approval
  return true;
}

/**
 * Classifies all tools and returns read vs write lists. Useful for logging.
 */
export function classifyTools(toolNames: string[]): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  for (const name of toolNames) {
    (isWriteTool(name) ? write : read).push(name);
  }
  return { read, write };
}
