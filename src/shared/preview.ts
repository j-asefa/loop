/** Public build facts only. Never include local paths or connection credentials. */
export interface PreviewInfo {
  name: string;
  mode: "design" | "working";
  build: {
    id: string;
    branch: string;
    commit: string;
    dirty: boolean;
    builtAt: string;
    sourceHash: string;
    artifactHash: string;
  };
}
