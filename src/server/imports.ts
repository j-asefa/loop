import { MessageMetadata } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";
import { z } from "zod";
import { transition, type Run } from "./queue.js";
import yauzl from "yauzl";
import { createHash } from "node:crypto";
import { db, id, now, emit } from "./db.js";
import { ownedImport, Problem } from "./domain.js";
import { saveArtifact } from "./artifacts.js";
export type ImportedMessage = {
  externalId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  raw: unknown;
  parent?: string | null;
  active?: boolean;
};
export type ImportedConversation = {
  externalId: string;
  title: string;
  timestamp: number;
  messages: ImportedMessage[];
  raw: unknown;
};
export type ParsedImport = {
  provider: "openai" | "anthropic";
  conversations: ImportedConversation[];
  warnings: string[];
  attachments: { name: string; bytes: Buffer }[];
};
const digest = (x: Buffer | string) =>
  createHash("sha256").update(x).digest("hex");
function timestamp(x: unknown) {
  if (typeof x === "number" && Number.isFinite(x))
    return x < 1e12 ? Math.round(x * 1000) : x;
  if (typeof x === "string") {
    const d = Date.parse(x);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}
function textParts(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof p?.text === "string"
            ? p.text
            : `[Attachment or non-text content: ${p?.asset_pointer || p?.type || p?.content_type || "unavailable"}]`,
      )
      .join("\n");
  return "[Content unavailable in this export]";
}
export function parseConversations(
  input: unknown,
): Omit<ParsedImport, "attachments"> {
  const list = Array.isArray(input) ? input : (input && typeof input === "object" && "conversations" in input ? input.conversations : undefined);
  if (!Array.isArray(list) || !list.length)
    throw new Problem(
      422,
      "No conversations found. Upload conversations.json from an official export.",
    );
  if (list.length > 20000)
    throw new Problem(
      413,
      "This export exceeds 20,000 conversations. Split it into smaller JSON files.",
    );
  const provider = list.some((c: any) => c?.mapping)
    ? "openai"
    : list.some((c: any) => Array.isArray(c?.chat_messages))
      ? "anthropic"
      : null;
  if (!provider)
    throw new Problem(
      422,
      "Unrecognized export format. Expected ChatGPT mapping or Claude chat_messages.",
    );
  const conversations: ImportedConversation[] = [],
    warnings: string[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") {
      warnings.push("Skipped a non-object conversation");
      continue;
    }
    const messages: ImportedMessage[] = [];
    const externalId = String(
      c.id || c.uuid || c.conversation_id || digest(JSON.stringify(c)),
    );
    if (provider === "openai") {
      if (!c.mapping || typeof c.mapping !== "object") {
        warnings.push(`Skipped ${externalId}: no mapping`);
        continue;
      }
      const active = new Set<string>();
      let node = c.current_node;
      while (node && c.mapping[node] && !active.has(node)) {
        active.add(node);
        node = c.mapping[node].parent;
      }
      for (const [nodeId, value] of Object.entries(c.mapping) as [
        string,
        any,
      ][]) {
        const m = value?.message;
        if (!m) continue;
        const role = m.author?.role;
        if (!["user", "assistant", "system"].includes(role)) continue;
        messages.push({
          externalId: String(m.id || nodeId),
          role,
          content: textParts(m.content?.parts ?? m.content?.text ?? m.content),
          timestamp: timestamp(m.create_time),
          parent: value.parent ?? null,
          active: active.size ? active.has(nodeId) : true,
          raw: { nodeId, ...value },
        });
      }
    } else {
      if (!Array.isArray(c.chat_messages)) {
        warnings.push(`Skipped ${externalId}: no chat_messages`);
        continue;
      }
      for (const m of c.chat_messages) {
        const role =
          m.sender === "human"
            ? "user"
            : m.sender === "assistant"
              ? "assistant"
              : null;
        if (!role) continue;
        const content =
          typeof m.text === "string" ? m.text : textParts(m.content);
        const attachments = [...(m.attachments || []), ...(m.files || [])];
        messages.push({
          externalId: String(m.uuid || m.id || digest(JSON.stringify(m))),
          role,
          content:
            content +
            (attachments.length
              ? "\n\n" +
                attachments
                  .map(
                    (a: any) =>
                      `[Attachment: ${a.file_name || a.name || a.id || "unnamed"} — bytes may be available in the original archive]`,
                  )
                  .join("\n")
              : ""),
          timestamp: timestamp(m.created_at),
          raw: m,
          active: true,
        });
      }
    }
    messages.sort((a, b) => a.timestamp - b.timestamp);
    conversations.push({
      externalId,
      title: String(c.title || c.name || "Imported conversation"),
      timestamp: timestamp(c.create_time || c.created_at),
      messages,
      raw: c,
    });
  }
  if (!conversations.length)
    throw new Problem(422, "No supported conversations in this export.");
  return { provider, conversations, warnings };
}
export async function readArchive(
  bytes: Buffer,
  name: string,
): Promise<ParsedImport> {
  if (bytes.length > 30 * 1024 * 1024)
    throw new Problem(413, "Upload up to 30 MB at a time.");
  if (!bytes.subarray(0, 2).equals(Buffer.from("PK"))) {
    try {
      return {
        ...parseConversations(JSON.parse(bytes.toString("utf8"))),
        attachments: [],
      };
    } catch (e) {
      if (e instanceof Problem) throw e;
      throw new Problem(422, "Could not read this JSON export.");
    }
  }
  const entries = await new Promise<{ name: string; bytes: Buffer }[]>(
    (resolve, reject) => {
      yauzl.fromBuffer(
        bytes,
        { lazyEntries: true, validateEntrySizes: true },
        (error, zip) => {
          if (error || !zip) {
            reject(new Problem(422, "Invalid ZIP archive"));
            return;
          }
          const files: { name: string; bytes: Buffer }[] = [];
          let size = 0,
            count = 0,
            done = false;
          const fail = (message: string) => {
            if (done) return;
            done = true;
            zip.close();
            reject(new Problem(422, message));
          };
          zip.on("error", () => fail("Could not read ZIP archive"));
          zip.on("end", () => {
            if (!done) {
              done = true;
              resolve(files);
            }
          });
          zip.on("entry", (entry: yauzl.Entry) => {
            if (++count > 2000)
              return fail("Archive has more than 2,000 entries");
            const n = entry.fileName;
            if (
              n.startsWith("/") ||
              n.includes("\\") ||
              n.split("/").includes("..") ||
              /^[A-Za-z]:/.test(n) ||
              ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
            )
              return fail("Archive contains an unsafe path or link");
            if (entry.generalPurposeBitFlag & 1)
              return fail("Encrypted archives are not supported");
            if (n.endsWith("/")) {
              zip.readEntry();
              return;
            }
            size += entry.uncompressedSize;
            if (
              size > 100 * 1024 * 1024 ||
              entry.uncompressedSize > 30 * 1024 * 1024
            )
              return fail("Expanded archive exceeds size limits");
            zip.openReadStream(entry, (err, stream) => {
              if (err || !stream)
                return fail("Could not read an archive entry");
              const chunks: Buffer[] = [];
              let actual = 0;
              stream.on("data", (chunk: Buffer) => {
                actual += chunk.length;
                if (
                  actual > entry.uncompressedSize ||
                  actual > 30 * 1024 * 1024
                ) {
                  stream.destroy();
                  fail("Invalid entry size");
                } else chunks.push(chunk);
              });
              stream.on("error", () => fail("Invalid compressed entry"));
              stream.on("end", () => {
                if (done) return;
                files.push({ name: n, bytes: Buffer.concat(chunks) });
                zip.readEntry();
              });
            });
          });
          zip.readEntry();
        },
      );
    },
  );
  const json = entries.find((e) => /(^|\/)conversations\.json$/i.test(e.name));
  if (!json) throw new Problem(422, "ZIP must contain conversations.json");
  let parsed;
  try {
    parsed = parseConversations(JSON.parse(json.bytes.toString("utf8")));
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(422, "Invalid conversations.json");
  }
  return { ...parsed, attachments: entries.filter((e) => e !== json) };
}
export async function stageImport(owner: string, bytes: Buffer, name: string) {
  const checksum = digest(bytes);
  const prior = db
    .prepare("SELECT * FROM imports WHERE owner_id=? AND digest=?")
    .get(owner, checksum) as QueryRow<"imports"> | undefined;
  if (prior)
    return { ...prior, summary: JSON.parse(prior.summary), duplicate: true };
  const parsed = await readArchive(bytes, name);
  return db
    .transaction(() => {
      const objectId = id(),
        job = id();
      db.prepare("INSERT INTO objects VALUES(?,?,?,?,?,?)").run(
        objectId,
        owner,
        name.slice(0, 180),
        "application/octet-stream",
        bytes,
        now(),
      );
      const summary = {
        objectId,
        conversations: parsed.conversations.length,
        messages: parsed.conversations.reduce(
          (n, c) => n + c.messages.length,
          0,
        ),
        attachments: parsed.attachments.length,
        warnings: parsed.warnings.slice(0, 100),
        titles: parsed.conversations.slice(0, 5).map((c) => c.title),
        completed: 0,
      };
      db.prepare("INSERT INTO imports VALUES(?,?,?,?,'preview',?,?)").run(
        job,
        owner,
        parsed.provider,
        checksum,
        JSON.stringify(summary),
        now(),
      );
      return { id: job, provider: parsed.provider, status: "preview", summary };
    })
    .immediate();
}
export async function executeImport(run: Run) {
  const importId = z.string().min(1).parse(run.payload.importId);
  const job = ownedImport(importId, run.owner_id),
    summary = JSON.parse(job.summary);
  const object = db
    .prepare("SELECT * FROM objects WHERE id=? AND owner_id=?")
    .get(summary.objectId, run.owner_id) as QueryRow<"objects"> | undefined;
  if (!object) throw new Error("Import file missing");
  const parsed = await readArchive(object.bytes, object.name);
  db.prepare("UPDATE imports SET status='running' WHERE id=?").run(importId);
  let agentId = summary.agentId;
  if (!agentId) {
    agentId = id();
    const name = `import-${parsed.provider}-${agentId.slice(0, 8)}`;
    db.transaction(() => {
      db.prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,?,?,?,'Imported history','','import',?)",
      ).run(agentId, run.owner_id, name, name, parsed.provider, now());
      db.prepare("INSERT INTO handles VALUES(?,?,?)").run(name, agentId, now());
      summary.agentId = agentId;
      db.prepare("UPDATE imports SET summary=? WHERE id=?").run(
        JSON.stringify(summary),
        importId,
      );
    }).immediate();
  }
  for (let index = 0; index < parsed.conversations.length; index++) {
    const state = (
      db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
        state: string;
      }
    ).state;
    if (state === "pausing") {
      db.prepare("UPDATE imports SET status='paused' WHERE id=?").run(importId);
      transition(run, "paused");
      return false;
    }
    if (state === "cancelled") {
      db.prepare("UPDATE imports SET status='cancelled' WHERE id=?").run(
        importId,
      );
      return false;
    }
    const c = parsed.conversations[index];
    db.transaction(() => {
      let conversation = db
        .prepare(
          "SELECT id FROM conversations WHERE owner_id=? AND origin=? AND external_id=?",
        )
        .get(run.owner_id, parsed.provider + "-import", c.externalId) as
        { id: string } | undefined;
      if (!conversation) {
        conversation = { id: id() };
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          conversation.id,
          run.owner_id,
          agentId,
          c.title,
          parsed.provider + "-import",
          c.externalId,
          c.timestamp || now(),
        );
      }
      for (const m of c.messages) {
        const external = c.externalId + ":" + m.externalId;
        if (
          db
            .prepare(
              "SELECT 1 FROM import_messages WHERE owner_id=? AND provider=? AND external_id=?",
            )
            .get(run.owner_id, parsed.provider, external)
        )
          continue;
        const messageId = id();
        db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
          messageId,
          run.owner_id,
          conversation.id,
          null,
          m.role,
          m.content,
          JSON.stringify(MessageMetadata.parse({
            origin: "import",
            provider: parsed.provider,
            externalId: m.externalId,
            parent: m.parent,
            activeBranch: m.active,
            importId,
            raw: m.raw,
          })),
          m.timestamp || c.timestamp || now(),
        );
        db.prepare("INSERT INTO import_messages VALUES(?,?,?,?)").run(
          run.owner_id,
          parsed.provider,
          external,
          messageId,
        );
      }
      if (
        !db
          .prepare(
            "SELECT 1 FROM artifacts WHERE owner_id=? AND conversation_id=?",
          )
          .get(run.owner_id, conversation.id)
      )
        saveArtifact(run.owner_id, {
          title: c.title,
          kind: "conversation",
          content: c.messages
            .filter((m) => m.active)
            .map((m) => `**${m.role}**\n\n${m.content}`)
            .join("\n\n"),
          agent: agentId,
          conversation: conversation.id,
          metadata: {
            origin: "import",
            provider: parsed.provider,
            importId,
            externalId: c.externalId,
            rawObjectId: summary.objectId,
          },
        });
      summary.completed = index + 1;
      db.prepare("UPDATE imports SET summary=? WHERE id=?").run(
        JSON.stringify(summary),
        importId,
      );
    }).immediate();
    emit(run.owner_id, run.id, "import.progress", {
      completed: index + 1,
      total: parsed.conversations.length,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!summary.attachmentsStored) {
    db.transaction(() => {
      for (const attachment of parsed.attachments) {
        const objectId = id();
        db.prepare("INSERT INTO objects VALUES(?,?,?,?,?,?)").run(
          objectId,
          run.owner_id,
          attachment.name,
          "application/octet-stream",
          attachment.bytes,
          now(),
        );
        saveArtifact(run.owner_id, {
          title: attachment.name,
          kind: "file",
          content: /\.(txt|md|csv|json)$/i.test(attachment.name)
            ? attachment.bytes.toString("utf8").slice(0, 100000)
            : "Original exported file. Binary content has not been interpreted.",
          agent: agentId,
          metadata: {
            objectId,
            importId,
            origin: "import",
            provider: parsed.provider,
          },
        });
      }
      summary.attachmentsStored = true;
      db.prepare("UPDATE imports SET summary=? WHERE id=?").run(
        JSON.stringify(summary),
        importId,
      );
    }).immediate();
  }
  db.prepare("UPDATE imports SET status='completed' WHERE id=?").run(importId);
}
