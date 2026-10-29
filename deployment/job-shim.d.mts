export function checkOptions(args: string[]): string[];
export function classifyCommand(
  program: string,
  args: string[],
  cwd?: string,
  context?: { ci?: boolean; tty?: boolean },
): {
  label?: string;
  args: string[];
  compiler: boolean;
};
export function shimScript(
  configPath: string,
  node: string,
  shim: string,
  program: string,
  command: string,
): string;
