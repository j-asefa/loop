import * as projectPathsQueries from "./sql/project-paths.js";
import * as workspaceProjectsQueries from "./sql/workspace-projects.js";
import * as nativeDecisionsQueries from "./sql/native-decisions.js";
import * as companionSessionsQueries from "./sql/companion-sessions.js";
import * as nativeItemsQueries from "./sql/native-items.js";
import { nativeAnswerTokenWrite } from "./token-write-policies.js";
import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";

import { enabled as memoryEnabled } from "./memory.js";
import { runtimeSetupState } from "../runtime-setup.js";
import { nativeHistory } from "./native-history.js";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.ts";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import { ownedFolder, ownedConversation, Problem } from "./domain.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { executionRequest } from "./execution-client.js";

const routes = registrar("companion", { middleware: [[nativeHistory]] });
export const companion = routes.mount;
routes.on(workspaceApi.runtimeProviders, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await executionRequest("provider.catalog", {
      name: req.params.name,
      projectId: req.query.projectId,
    }),
  );
});
routes.on(workspaceApi.runtimeProviderKey, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { commandId, ...input } = req.body;
  res.json(
    await executionRequest(
      "provider.key",
      { ...input, name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeProviderRemove, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { commandId, ...input } = req.body;
  res.json(
    await executionRequest(
      "provider.remove",
      { ...input, name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeProviderRefresh, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { commandId, ...input } = req.body;
  res.json(
    await executionRequest(
      "provider.refresh",
      { ...input, name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeAuthProviders, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await executionRequest("auth.catalog", {
      name: req.params.name,
      projectId: req.query.projectId,
    }),
  );
});
routes.on(workspaceApi.runtimeAuthStatus, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executionRequest("auth.status", { name: req.params.name }));
});
routes.on(workspaceApi.runtimeAuthStart, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { commandId, ...input } = req.body;
  res.json(
    await executionRequest(
      "auth.start",
      { ...input, name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeAuthInput, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await executionRequest("auth.input", {
      ...req.body,
      name: req.params.name,
    }),
  );
});
routes.on(workspaceApi.runtimeAuthCancel, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await executionRequest("auth.cancel", {
      ...req.body,
      name: req.params.name,
    }),
  );
});
routes.on(workspaceApi.workspace, async (_req, res) =>
  res.json({
    harnesses: nativeSessions.registrations(),
    ...(await executionRequest("runtime.status", {})),
    concurrency: MAX_CONCURRENT_RUNS,
    hostLifetime: "foreground",
    tunnelOrigin: config.url,
    projectPaths: projectPathsQueries.all(db) as z.input<
      typeof workspaceApi.workspace.response
    >["projectPaths"],
  }),
);
routes.on(workspaceApi.runtimeList, async (req, res) => {
  const runtimes = await executionRequest("runtime.list", {
    fresh: req.query.fresh === "1",
  });
  res.json({ ...runtimes, setup: runtimeSetupState() });
});
routes.on(workspaceApi.runtimeUpgrade, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(
    await executionRequest("upgrade.status", {
      name: req.params.name,
      check: req.query.check === "1",
    }),
  );
});
routes.on(workspaceApi.runtimeUpgradeStart, async (req, res) => {
  const { commandId } = req.body;
  res.json(
    await executionRequest(
      "upgrade.start",
      { name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeUpgradeDismiss, async (req, res) => {
  res.json(
    await executionRequest("upgrade.dismiss", { name: req.params.name }),
  );
});
routes.on(workspaceApi.runtimeUpgradeRecover, async (req, res) => {
  const { commandId, confirmedStopped } = req.body;
  res.json(
    await executionRequest(
      "upgrade.recover",
      { name: req.params.name, confirmedStopped },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.runtimeEnable, async (req, res) => {
  const { commandId, ...input } = req.body;
  res.json(
    await executionRequest(
      "runtime.enable",
      { ...input, name: req.params.name },
      { commandId },
    ),
  );
});
routes.on(workspaceApi.workspaceProjectCreate, (req, res) => {
  const d = req.body;
  res
    .status(201)
    .json(
      nativeSessions.addProject(d.path, d.name) as z.input<
        typeof workspaceApi.workspaceProjectCreate.response
      >,
    );
});
routes.on(workspaceApi.workspaceProjectUpdate, (req, res) => {
  ownedFolder(String(req.params.id), OWNER);
  if (workspaceProjectsQueries.exists(db, OWNER, req.params.id))
    throw new Problem(400, "Choose a named project for a local directory.");
  const { path } = req.body;
  const real = nativeSessions.directory(path);
  if (projectPathsQueries.usedElsewhere(db, real, req.params.id))
    throw new Problem(
      409,
      "That directory already belongs to another project.",
    );
  projectPathsQueries.upsert(db, req.params.id, real);
  res.json({
    ok: true,
    path: real,
    note: "Existing native conversations keep their original directory.",
  });
});
routes.on(workspaceApi.nativeDecisions, (req, res) => {
  const { conversation } = req.query;
  if (conversation) ownedConversation(conversation, OWNER);
  res.json(
    nativeDecisionsQueries.visibleForOwner(
      db,
      OWNER,
      conversation || null,
    ) as z.input<typeof workspaceApi.nativeDecisions.response>,
  );
});
routes.on(
  workspaceApi.nativeAnswer,
  async (req, res) => {
    const d = req.body;
    res.json(
      await executionRequest(
        "native.answer",
        { decisionId: String(req.params.id), answer: d.answer },
        { owner: res.locals.owner, commandId: d.commandId },
      ),
    );
  },
  { tokenWrite: nativeAnswerTokenWrite },
);
routes.on(workspaceApi.session, async (req, res) => {
  const conversation = req.params.id;
  ownedConversation(conversation, OWNER);
  res.json(
    await executionRequest("native.controls", { conversationId: conversation }),
  );
});
routes.on(workspaceApi.setting, async (req, res) => {
  const conversation = req.params.id;
  ownedConversation(conversation, OWNER);
  const body = req.body;
  res.json(
    await executionRequest(
      "native.setting",
      {
        conversationId: conversation,
        setting: String(req.params.setting),
        value: body.value,
        revision: body.revision,
        generation: body.generation,
      },
      { commandId: body.commandId },
    ),
  );
});
routes.on(workspaceApi.conversationNative, (req, res) => {
  ownedConversation(req.params.id, OWNER);
  const binding = companionSessionsQueries.publicSession(
    db,
    req.params.id,
  ) as z.input<typeof workspaceApi.conversationNative.response>["binding"];
  const items = nativeItemsQueries.sessionItems(db, req.params.id) as {
    item: string;
  }[];
  res.json({
    binding,
    memoryIncluded: memoryEnabled(
      OWNER,
      "conversation:" + req.params.id,
      false,
    ),
    items: items.map((x) => JSON.parse(x.item)),
    projection: true,
    note: "Native history remains authoritative. This is Loop's recorded display projection.",
  });
});
