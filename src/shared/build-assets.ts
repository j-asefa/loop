type AssetUse = "support" | "package" | "preview" | "copy-back";

export const BUILD_ASSETS: readonly {
  path: string;
  uses: readonly AssetUse[];
}[] = [
  { path: "dist", uses: ["package", "preview", "copy-back"] },
  { path: "migrations", uses: ["support", "package", "preview"] },
  { path: "docs", uses: ["package"] },
  { path: "README.md", uses: ["package"] },
  { path: "npm-shrinkwrap.json", uses: ["package", "copy-back"] },
  { path: "deployment", uses: ["support", "package"] },
  { path: "package.json", uses: ["support", "preview"] },
  { path: "package-lock.json", uses: ["preview"] },
];
