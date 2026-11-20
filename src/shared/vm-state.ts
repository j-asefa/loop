import { z } from "zod";

// The single owner of the experiment_vms.state vocabulary and its edges.
// transitionVm() in src/server/vm/machine.ts is the only writer.
export const VM_TRANSITIONS = {
  // sleeping/paused: a reconcile adopted a VM the provider reports asleep.
  provisioning: ["running", "sleeping", "paused", "failed", "destroying"],
  running: ["sleeping", "paused", "destroying", "failed"],
  sleeping: ["running", "destroying", "failed"],
  paused: ["running", "destroying", "failed"],
  // Only the owner's explicit reconcile, retry or destroy leaves failed.
  // sleeping/paused: a reconcile or retry adopted a VM found asleep.
  failed: ["provisioning", "running", "sleeping", "paused", "destroying"],
  destroying: ["destroyed", "failed"],
  // Terminal: the project, its threads, results and files stay readable.
  destroyed: [],
} as const;
export type VmState = keyof typeof VM_TRANSITIONS;
export const VmState = z.enum(
  Object.keys(VM_TRANSITIONS) as [VmState, ...VmState[]],
);

export function legalVmTransition(from: VmState, to: VmState) {
  const destinations: readonly VmState[] = VM_TRANSITIONS[from];
  return destinations.includes(to);
}

// vm_operations.state. pending is written before the provider call. A
// pending row found at startup, or a call whose outcome was not observed,
// becomes uncertain; only the owner's reconcile settles it.
export const VM_OPERATION_TRANSITIONS = {
  pending: ["succeeded", "failed", "uncertain"],
  uncertain: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
} as const;
export type VmOperationState = keyof typeof VM_OPERATION_TRANSITIONS;
export const VmOperationState = z.enum(
  Object.keys(VM_OPERATION_TRANSITIONS) as [
    VmOperationState,
    ...VmOperationState[],
  ],
);

export function legalVmOperationTransition(
  from: VmOperationState,
  to: VmOperationState,
) {
  const destinations: readonly VmOperationState[] =
    VM_OPERATION_TRANSITIONS[from];
  return destinations.includes(to);
}

export const VmOperationKinds = [
  "create",
  "fork",
  "sleep",
  "resume",
  "expose",
  "unexpose",
  "destroy",
] as const;
export const VmOperationKind = z.enum(VmOperationKinds);
export type VmOperationKind = z.infer<typeof VmOperationKind>;

export const VmProviderKind = z.enum(["sailbox"]);
export type VmProviderKind = z.infer<typeof VmProviderKind>;

export const VmHarness = z.enum(["claude", "codex", "antigravity", "pi"]);
export type VmHarness = z.infer<typeof VmHarness>;
