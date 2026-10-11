function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Codex encodes a tool confirmation as an empty MCP form. Other forms
 * require real user input and must never be accepted as tool approvals. */
export function codexToolApproval(value: unknown) {
  if (!record(value) || value.mode !== "form" || !record(value._meta)) return;
  const meta = value._meta;
  const schema = value.requestedSchema;
  if (
    meta.codex_approval_kind !== "mcp_tool_call" ||
    typeof value.serverName !== "string" ||
    typeof value.message !== "string" ||
    !record(schema) ||
    schema.type !== "object" ||
    !record(schema.properties) ||
    Object.keys(schema.properties).length !== 0 ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
    Object.keys(schema).some(
      (key) =>
        ![
          "type",
          "properties",
          "required",
          "additionalProperties",
          "$schema",
        ].includes(key),
    ) ||
    (schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean")
  )
    return;
  return {
    server: value.serverName,
    tool:
      typeof meta.tool_title === "string"
        ? meta.tool_title
        : typeof meta.tool_name === "string"
          ? meta.tool_name
          : undefined,
    message: value.message,
    arguments: meta.tool_params,
  };
}
