export type JobConfiguration = {
  pueue: string;
  config: string;
  jobs: string;
  group: string;
  worker?: string;
  shims?: string;
  commands?: Record<string, string>;
};
export type PueueTask = {
  id: number;
  group: string;
  label: string | null;
  status: string | Record<string, unknown>;
};
export function queueConfiguration(path?: string): Promise<JobConfiguration>;
export function insideQueuedJob(config: JobConfiguration): boolean;
export function queueCommand(
  config: JobConfiguration,
  args: string[],
): Promise<string>;
export function queueStatus(config: JobConfiguration): Promise<{
  tasks: Record<string, PueueTask>;
  groups: Record<string, { status: string; parallel_tasks: number }>;
}>;
export function taskState(task: PueueTask): string;
export function cancelQueuedJob(
  config: JobConfiguration,
  identity: string,
): Promise<void>;
export function runQueuedJob(
  command: string,
  args: string[],
  options?: {
    label?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    stdio?: "inherit" | "ignore";
    signal?: AbortSignal;
    log?: (line: string) => void;
  },
): Promise<number>;
