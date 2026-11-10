/** Structured native display extraction. These values never authorize file or command execution. */
export type DirectActivity =
  | {
      kind: "plan";
      id: string;
      steps: { id: string; text: string; status: string }[];
      explanation?: string;
    }
  | {
      kind: "file";
      id: string;
      path: string;
      tool?: string;
      oldPath?: string;
      operation?: "create" | "modify" | "delete" | "rename";
      patch?: string;
      before?: string | null;
      after?: string | null;
      state: string;
      truncated?: boolean;
    }
  | {
      kind: "output";
      id: string;
      command?: string;
      cwd?: string;
      text: string;
      stream: "combined";
      state: string;
      exitCode?: number;
      truncated?: boolean;
    };
