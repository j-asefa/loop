export function classifyCommand(
  program: string,
  args: string[],
  cwd?: string,
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
