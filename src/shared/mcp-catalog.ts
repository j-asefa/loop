export type CatalogInput = { key: string; label: string; secret: boolean };
export type CatalogEntry = {
  id: string;
  name: string;
  publisher: string;
  category: string;
  description: string;
  source: string;
  auth: "none" | "oauth" | "bearer" | "query" | "oauth-app" | "env";
  inputs: CatalogInput[];
  note?: string;
  transport: "http" | "stdio";
  serverUrl?: string;
};
export type CatalogResponse = {
  entries: CatalogEntry[];
  reviewedAt: string;
  oauthRedirectUrl: string;
};
export type CatalogInstallResult = {
  id: string;
  status: "connected" | "needs_auth" | "disabled";
  tools: number;
  authorizationUrl?: string;
  error?: string;
};
