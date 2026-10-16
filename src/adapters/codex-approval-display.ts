import { createHash } from "node:crypto";
import { codexToolApproval } from "../shared/codex-approval.js";

/** Display-only projection. The adapter keeps the original RPC request for
 * answering; neither the payload nor the scope of consent is changed here. */
export function codexApprovalDetail(params: any): string {
  const approval = codexToolApproval(params);
  const meta = params?._meta;
  const args = approval?.arguments as Record<string, unknown> | undefined;
  // Older Codex versions identify the tool only in this generated message.
  // Do not summarize arbitrary commands, forms, or other servers' arguments.
  const publish =
    approval?.server === "loop_workspace" &&
    approval.message ===
      'Allow the loop_workspace MCP server to run tool "loop_publish_file"?' &&
    (meta.tool_name === undefined || meta.tool_name === "loop_publish_file") &&
    (meta.tool_title === undefined || meta.tool_title === "loop_publish_file");
  if (
    !publish ||
    !args ||
    Array.isArray(args) ||
    args.encoding !== "base64" ||
    typeof args.content !== "string"
  )
    return JSON.stringify(params, null, 2);

  const bytes = Buffer.from(args.content, "base64");
  if (bytes.toString("base64") !== args.content)
    return JSON.stringify(params, null, 2);
  const summary = `[Base64 file content: ${bytes.length} bytes; SHA-256 ${createHash("sha256").update(bytes).digest("hex")}]`;
  const display = structuredClone(params);
  display._meta.tool_params.content = summary;
  // Only replace exact copies of the payload; any other display fields remain
  // reviewable and subject to the existing decision-size guard.
  if (Array.isArray(display._meta.tool_params_display)) {
    for (const field of display._meta.tool_params_display) {
      if (field?.name === "content" && field.value === args.content)
        field.value = summary;
    }
  }
  return JSON.stringify(display, null, 2);
}
