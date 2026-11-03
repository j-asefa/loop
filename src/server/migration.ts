import * as nativeImportWorkspacesQueries from "./sql/native-import-workspaces.js";
import * as companionSessionsQueries from "./sql/companion-sessions.js";
import * as connectionsQueries from "./sql/connections.js";
import * as agentsQueries from "./sql/agents.js";
import * as handlesQueries from "./sql/handles.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as nativeItemsQueries from "./sql/native-items.js";
import * as legacyImportsQueries from "./sql/legacy-imports.js";
import * as messagesQueries from "./sql/messages.js";
import { readdir, readFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db, id, now } from "./db.js";
import {
  nativeSessions,
  OWNER,
  prepareImportedWorkspace,
} from "./native-sessions.js";
import { control } from "../host-control.js";
import { config } from "./config.js";
import type { Options } from "../adapters/types.js";
import { Harness, type Item } from "../protocol.js";
import { Problem } from "./domain.js";
import type { AgentWorkspace } from "./agent-worktree.js";

type PreparedImport = {
  agent: string;
  project: string;
  workspace: AgentWorkspace;
};
const preparingImports = new Map<string, Promise<PreparedImport>>();
// Prepare before the result-import transaction or an external fork.
export async function prepareImportSession(
  options: Options,
  kind: "fork" | "desktop",
  importKey: string,
  source: string,
): Promise<PreparedImport> {
  const project = nativeSessions.directory(options.project);
  // Commit the identity before creating files. Retries and concurrent handoffs
  // reuse it, and an uncertain fork retains its workspace under the command ID.
  const row = db
    .transaction(() => {
      const previous = nativeImportWorkspacesQueries.destination(
        db,
        OWNER,
        kind,
        importKey,
      ) as { harness: string; project: string; source: string } | undefined;
      if (previous && previous.source !== source)
        throw new Problem(
          409,
          "Command identity belongs to another conversation",
        );
      if (
        previous &&
        (previous.harness !== options.harness || previous.project !== project)
      )
        throw new Problem(
          409,
          "This native import was prepared for a different harness or directory. Use its original destination.",
        );
      nativeImportWorkspacesQueries.insert(
        db,
        OWNER,
        kind,
        importKey,
        source,
        options.harness,
        project,
        id(),
        now(),
      );
      const saved = nativeImportWorkspacesQueries.pending(
        db,
        OWNER,
        kind,
        importKey,
      ) as {
        agent_id: string;
        workspace: string | null;
      };
      return saved;
    })
    .immediate();
  const key = row.agent_id;
  const pending = preparingImports.get(key);
  if (pending) return pending;
  const preparation = (async () => {
    const expected =
      row.workspace === null
        ? undefined
        : (JSON.parse(row.workspace) as AgentWorkspace);
    const workspace = await prepareImportedWorkspace(
      project,
      row.agent_id,
      options.harness,
      expected,
    );
    const published = nativeImportWorkspacesQueries.setWorkspace(
      db,
      JSON.stringify(workspace),
      OWNER,
      row.agent_id,
      row.workspace,
    );
    if (!published.changes)
      throw new Problem(
        409,
        "The native import workspace changed during preparation. Retry with its saved binding.",
      );
    return { agent: row.agent_id, project, workspace };
  })();
  preparingImports.set(key, preparation);
  try {
    return await preparation;
  } finally {
    if (preparingImports.get(key) === preparation) preparingImports.delete(key);
  }
}

export function importSession(
  options: Options,
  nativeId: string,
  items: Item[],
  title: string,
  prepared?: Awaited<ReturnType<typeof prepareImportSession>>,
) {
  const existing = companionSessionsQueries.nativeWorkspace(
    db,
    options.harness,
    nativeId,
  ) as any;
  if (existing) {
    if (
      prepared &&
      (existing.project !== prepared.workspace.directory ||
        existing.worktree_source !== prepared.workspace.worktreeSource ||
        existing.worktree_agent_id !== prepared.agent)
    )
      throw new Problem(
        409,
        "This native session was imported into a different workspace. Open its existing conversation or start a new native session.",
      );
    return existing.conversation_id as string;
  }
  if (prepared) {
    const consumed = nativeImportWorkspacesQueries.complete(
      db,
      now(),
      OWNER,
      prepared.agent,
      prepared.project,
      options.harness,
      JSON.stringify(prepared.workspace),
    );
    if (!consumed.changes)
      throw new Problem(
        409,
        "The native import workspace changed or was already imported. Retry the handoff with a fresh preparation.",
      );
  }
  const agent = prepared?.agent ?? id(),
    conversation = id(),
    name = "resumed-" + id().slice(0, 8);
  const project = prepared?.project ?? options.project;
  // Fresh handoffs and forks need the same pinned workspace as new chats.
  // Backups retain their legacy directory and remain read-only until the user
  // starts a new conversation; migration must not fetch or move native context.
  const workspace = prepared?.workspace ?? {
    directory: project,
    worktreeSource: null,
  };
  const folder = nativeSessions.addProject(project) as any;
  const connection = connectionsQueries.id(
    db,
    "native-" + options.harness,
  ) as any;
  agentsQueries.insertNativeImport(
    db,
    agent,
    OWNER,
    name,
    name,
    options.harness === "claude" ? "anthropic" : options.harness,
    connection?.id || null,
    "native-default",
    now(),
    folder.id,
  );
  handlesQueries.insert(db, name, agent, now());
  conversationsQueries.insertNativeImport(
    db,
    conversation,
    OWNER,
    agent,
    title,
    now(),
  );
  companionSessionsQueries.insertImported(
    db,
    conversation,
    options.harness,
    nativeId,
    workspace.directory,
    now(),
    workspace.worktreeSource,
    prepared ? agent : null,
  );
  for (const item of items.slice(-2000)) {
    if (!item || typeof item.text !== "string") continue;
    nativeItemsQueries.insertImported(
      db,
      conversation,
      item.id || id(),
      JSON.stringify(item),
      now(),
    );
    if (["user", "assistant"].includes(item.kind))
      messagesQueries.insertImported(
        db,
        id(),
        OWNER,
        conversation,
        item.kind,
        item.text.slice(-256000),
        JSON.stringify({ native: true, migratedProjection: true }),
        now(),
      );
  }
  return conversation;
}
export async function resumeFromDesktop(options: Options, nativeId: string) {
  if (!nativeId || nativeId.length > 4096)
    throw new Error("Invalid native session identifier");
  const existing = companionSessionsQueries.nativeHandoff(
    db,
    options.harness,
    nativeId,
  ) as
    | {
        conversation_id: string;
        project: string;
        worktree_agent_id: string | null;
        source: string;
      }
    | undefined;
  // Legacy bindings reopen read-only history even when their raw directory
  // used an alias or has moved. Dispatch still requires a verified binding.
  if (existing && !existing.worktree_agent_id) return existing.conversation_id;
  const project = nativeSessions.directory(options.project);
  if (existing) {
    if (existing.source !== project && existing.project !== project)
      throw new Problem(
        409,
        "This native session is already bound to a different directory. Open its existing conversation or start a new native session.",
      );
    return existing.conversation_id;
  }
  const prepared = await prepareImportSession(
    { ...options, project },
    "desktop",
    JSON.stringify([options.harness, nativeId, project]),
    nativeId,
  );
  return db
    .transaction(() =>
      importSession(options, nativeId, [], "Native session handoff", prepared),
    )
    .immediate();
}
export async function migrateLegacy(root: string) {
  const projects = join(root, "projects");
  const dirs = await readdir(projects, { withFileTypes: true }).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-f0-9]{20}$/.test(dir.name)) continue;
    const path = join(projects, dir.name);
    if (await control(path, "status").catch(() => undefined))
      throw new Error(
        "A legacy per-project Loop host is still running. Stop it using that version before migration. Its state and native sessions were preserved.",
      );
    const file = join(path, "session.json");
    const raw = await readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    if (!raw) continue;
    if (raw.length > 8 * 1024 * 1024)
      throw new Error(
        "Legacy display snapshot exceeds the migration limit. Original state preserved: " +
          file,
      );
    const digest = createHash("sha256").update(raw).digest("hex");
    const prior = legacyImportsQueries.digest(db, file) as any;
    if (prior) {
      if (prior.digest !== digest)
        console.error(
          "Legacy snapshot changed after migration; preserving both copies without overwriting workspace history: " +
            file,
        );
      continue;
    }
    const snapshot = JSON.parse(raw).snapshot;
    const harness = Harness.parse(snapshot.harness);
    if (!snapshot.nativeSession) continue;
    const backup = join(config.data, "legacy-backups");
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await copyFile(
      file,
      join(backup, dir.name + "-" + digest.slice(0, 12) + ".json"),
    );
    db.transaction(() => {
      const conversation = importSession(
        {
          harness,
          project: snapshot.project,
          executable: "",
          version: snapshot.version,
          billing: snapshot.billing.mode,
        },
        snapshot.nativeSession,
        snapshot.items || [],
        "Migrated " + harness + " conversation",
      );
      legacyImportsQueries.insert(db, file, conversation, digest, now());
    }).immediate();
  }
}
