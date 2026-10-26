export const SLOT_BUSY_EXIT: 75;
export function privateLockDir(): string | null;
export function withTypecheckSlot(
  command: string,
  args: string[],
  options?: {
    lockFile?: string;
    waitSeconds?: number;
    reserveMiB?: number;
    stdio?: "inherit" | "ignore";
    log?: (line: string) => void;
  },
): Promise<number>;
