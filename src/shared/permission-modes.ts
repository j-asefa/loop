// The workspace's standing approval level for native harness tool calls
// (Settings → Permissions → Agent tool calls). Harnesses that accept a launch
// mode start new sessions in it; Loop answers the others' one-call approvals.
// A live session can still be changed from Session settings, which exposes
// the harness's own raw modes.
export const PERMISSION_MODES = [
  {
    value: "default",
    label: "Ask every time",
    description:
      "Every file write, command and network call waits for your approval.",
  },
  {
    value: "acceptEdits",
    label: "Auto-accept file edits",
    description:
      "Claude applies edits inside the project without asking. Commands, other tools and other harnesses still ask.",
  },
  {
    value: "bypassPermissions",
    label: "Never ask",
    description:
      "The agent runs every tool it chooses, including shell commands, without approval.",
  },
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number]["value"];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode.value === value);
}
// Only these harnesses accept a permission mode at launch.
export const PERMISSION_MODE_HARNESSES = ["claude"];
export function supportsPermissionMode(harness?: string | null) {
  return !!harness && PERMISSION_MODE_HARNESSES.includes(harness);
}
/**
 * The choice Loop answers for the user, if any. "Never ask" approves single
 * tool calls on every harness; questions and elicitations always wait.
 */
export function autoApproval(
  mode: PermissionMode | undefined,
  request: { kind: string; allow?: string; choices?: string[] },
) {
  return mode === "bypassPermissions" &&
    request.kind === "approval" &&
    request.allow &&
    request.choices?.includes(request.allow)
    ? request.allow
    : undefined;
}
/** The mode a native session may be launched with: never an unknown string. */
export function launchPermissionMode(
  harness: string | null | undefined,
  mode: unknown,
): PermissionMode {
  return supportsPermissionMode(harness) && isPermissionMode(mode)
    ? mode
    : DEFAULT_PERMISSION_MODE;
}
