import type { z } from "zod";
import type {
  PublicMcpCatalog,
  PublicMcpCatalogInstall,
} from "./mcp-contract-schemas.js";

export type CatalogResponse = z.output<typeof PublicMcpCatalog>;
export type CatalogEntry = CatalogResponse["entries"][number];
export type CatalogInput = CatalogEntry["inputs"][number];
export type CatalogInstallResult = z.output<typeof PublicMcpCatalogInstall>;
