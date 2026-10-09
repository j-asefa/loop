/** HAPI reports tool approvals and human-input requests in the same map. */
export function hapiAutoApproval(mode: unknown, request: unknown): boolean {
  if (mode !== "bypassPermissions" || !request || typeof request !== "object")
    return false;
  const r = request as { tool?: unknown; arguments?: unknown };
  if (typeof r.tool !== "string" || !r.tool.trim()) return false;
  // Questions, plan review and elicitations always need human input, even
  // when the request is malformed or omits its questions array.
  if (
    /question|request.?user.?input|ask.?user|elicitation|plan.?mode|plan.?review/i.test(
      r.tool,
    )
  )
    return false;
  let args = r.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return false;
    }
  }
  if (args && typeof args === "object" && "questions" in args) return false;
  // Only known execution tools qualify. Revisit this list with the HAPI pin
  // in deployment/versions.json; newly introduced human-input tools must wait.
  return /^(?:Bash|CodexBash|CodexPatch|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|WebFetch|WebSearch|TodoWrite|Task|apply_patch)$/i.test(r.tool);

}
