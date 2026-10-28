// Named migration exceptions. Removing a key makes its registration fail to compile.
export const LEGACY_ROUTES = {
  "GET /conversations/:id/memory": "memoryRoutes",
  "GET /memory": "memoryRoutes",
  "PUT /memory/policy": "memoryRoutes",
  "GET /memory/sources/:id": "memoryRoutes",
  "DELETE /memory/sources/:id": "memoryRoutes",
  "POST /memory/notes": "memoryRoutes",
  "GET /runs/:id/memory": "memoryRoutes",
  "PATCH /memory/notes/:id": "memoryRoutes",
  "GET /memory/notes/:id/versions": "memoryRoutes",
  "GET /workflows": "workflows",
  "POST /workflows/validate": "workflows",
  "POST /workflows": "workflows",
  "GET /workflows/:id": "workflows",
  "POST /workflows/:id/run": "workflows",
  "GET /runs/:id/steps": "workflows",
} as const;
