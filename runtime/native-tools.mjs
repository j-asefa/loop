// Loop enables native tools in managed containers and paired hosts. Only
// answer approvals for the thread created by this Loop operation.
export function nativeReply(message, threadId) {
  if (!threadId || message.params?.threadId !== threadId)
    return {
      error: {
        code: -32602,
        message: "This request does not belong to this Loop thread.",
      },
    };
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(message.method)
  )
    return { result: { decision: "accept" } };
  if (message.method === "item/permissions/requestApproval")
    return {
      result: { permissions: message.params.permissions || {}, scope: "turn" },
    };
  if (message.method === "item/tool/requestUserInput")
    return { result: { answers: {} } };
  if (message.method === "mcpServer/elicitation/request")
    return { result: { action: "cancel", content: null } };
  return {
    error: {
      code: -32601,
      message:
        "This client-side interaction is not available. Ask the user in your Loop reply; native host tools remain available.",
    },
  };
}
