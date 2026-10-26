export const SLOT_BUSY_EXIT: 75;
export function watchRequested(args: string[]): boolean;
export function privateLockDir(): string | null;
export function withHeavySlot(
  command: string,
  args: string[],
  options?: {
    label?: string;
    schedule?: boolean;
    lockFile?: string;
    waitSeconds?: number;
    reserveMiB?: number;
    stdio?: "inherit" | "ignore";
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    log?: (line: string) => void;
  },
): Promise<number>;
