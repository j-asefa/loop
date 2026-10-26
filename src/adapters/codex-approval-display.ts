import { createHash } from "node:crypto";
import { codexToolApproval } from "../shared/codex-approval.js";

/** Display-only projection. The adapter keeps the original RPC request for
 * answering; neither the payload nor the scope of consent is changed here. */
export function codexApprovalDetail(params: any): string {
  const approval = codexToolApproval(params);
  const meta = params?._meta;
  const args = approval?.arguments as Record<string, unknown> | undefined;
  const github = githubFileApproval(params);
  if (github) return JSON.stringify(github, null, 2);
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

/** File bytes are not the scope of an upload approval. Keep the destination,
 * paths, modes, commit message and other arguments intact, and identify each
 * large file by its exact encoded size and hash. This is independent of the
 * permission mode: manual consent must work for large uploads too. */
function githubFileApproval(params: any) {
  const approval = codexToolApproval(params);
  if (!approval) return;
  const meta = params._meta;
  const generated =
    /^Allow the github MCP server to run tool "([^"]+)"\?$/i.exec(
      approval.message,
    );
  const name =
    typeof meta.tool_name === "string"
      ? meta.tool_name
      : generated?.[1] || approval.tool;
  if (typeof name !== "string") return;
  const namespaced =
    /^(?:github[./]|mcp__github__)/.test(name) ||
    /^(?:github[./]|mcp__github__)/.test(approval.tool || "");
  if (!namespaced && approval.server.toLowerCase() !== "github" && !generated)
    return;
  const tool = name.replace(/^(?:github[./]|mcp__github__)/, "");
  if (
    ![
      "create_tree",
      "push_files",
      "create_blob",
      "create_or_update_file",
      "create_or_update_file_contents",
    ].includes(tool)
  )
    return;
  const args = approval.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const display = structuredClone(params);
  const projected = display._meta.tool_params;
  const files =
    tool === "create_tree"
      ? projected.tree
      : tool === "push_files"
        ? projected.files
        : [projected];
  if (!Array.isArray(files)) return;
  // Many individually small files (including JSON escaping) can exceed the
  // display budget together. Keep small contents visible when they still fit.
  const smallBytes = files.reduce(
    (total, file) =>
      typeof file?.content === "string" &&
      Buffer.byteLength(file.content) <= 2048
        ? total + Buffer.byteLength(JSON.stringify(file.content))
        : total,
    0,
  );
  let changed = false;
  for (const file of files) {
    if (!file || typeof file !== "object" || typeof file.content !== "string")
      continue;
    const bytes = Buffer.byteLength(file.content);
    if (bytes <= 2048 && smallBytes <= 8000) continue;
    const digest = createHash("sha256").update(file.content).digest("hex");
    file.content = `[File content omitted from preview: ${bytes} UTF-8 bytes in the supplied content string; SHA-256 ${digest}]`;
    changed = true;
  }
  if (!changed) return;
  // Codex may repeat the same file as raw text, a nested object or serialized
  // JSON in its generated display fields. Regenerate that duplicate view from
  // the canonical arguments so its formatting cannot reintroduce file bytes.
  if (meta.tool_params_display !== undefined)
    display._meta.tool_params_display = Object.entries(projected).map(
      ([name, value]) => ({ name, value }),
    );
  return display;
}
