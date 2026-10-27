export function runSupervised(
  command: string,
  args: string[],
  options?: {
    label?: string;
    stdio?: "inherit" | "ignore";
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    log?: (line: string) => void;
  },
): Promise<number>;
