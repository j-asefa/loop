export function underlyingCommand(
  name: string,
  options: {
    previous?: { commands?: Record<string, string> };
    bin: string;
    node: string;
    path?: string;
  },
): Promise<string>;
