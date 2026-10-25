// Complete acknowledgement for UI-only sends that must leave seeded messages unchanged.
export function runReceipt(request, id) {
  const body = request.postDataJSON();
  const now = Date.now();
  return {
    id,
    agent_id: body.agentId ?? null,
    conversation_id: body.conversationId ?? null,
    input: body.input,
    state: "queued",
    payload: JSON.stringify(body),
    result: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}
