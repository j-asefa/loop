import type { QueryRow } from "./query-records.js";
import { InvalidRow, requireSealedSecret } from "./row-schemas.js";
import { ownedConnection } from "./domain.js";
import { searchExcerpt } from "../shared/search-excerpt.js";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { db, now } from "./db.js";
import { unseal } from "./secrets.js";

import { localEmbeddings, localModel } from "./local-embeddings.js";
import { traceArtifactSql } from "./results.js";
export type SearchDoc = {
  id: string;
  owner_id: string;
  kind: string;
  title: string;
  content: string;
  agent_id: string | null;
  conversation_id: string | null;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
  name?: string;
  provider?: string;
};
const modelDefault =
  process.env.LOOP_EMBEDDING_MODEL || "text-embedding-3-small";
const hash = (d: SearchDoc) =>
  createHash("sha256")
    .update(d.title + "\n" + d.content)
    .digest("hex");
type EmbeddingConfig = {
  id: string;
  owner_id: string;
  embedding_model: string | null;
  local?: true;
};
function embeddingConfig(owner: string): EmbeddingConfig | undefined {
  const preference = db
    .prepare("SELECT * FROM preferences WHERE owner_id=?")
    .get(owner) as QueryRow<"preferences"> | undefined;
  if (preference?.embedding_enabled && !preference.embedding_connection)
    return {
      id: "local",
      owner_id: owner,
      embedding_model: localModel,
      local: true,
    };
  return db
    .prepare(
      "SELECT c.id,c.owner_id,p.embedding_model FROM preferences p JOIN connections c ON c.id=p.embedding_connection AND c.owner_id=p.owner_id WHERE p.owner_id=? AND p.embedding_enabled=1 AND c.provider='openai' AND c.status='connected'",
    )
    .get(owner) as EmbeddingConfig | undefined;
}
// The selected shared corpus has one embedding owner (MemSearch). Existing
// lexical search remains available; unrelated existing search keeps its backend.
const eligibleText =
  "length(trim(d.title || ' ' || d.content))>0 AND NOT EXISTS(SELECT 1 FROM memory_sources ms WHERE ms.owner_id=d.owner_id AND (ms.kind||':'||ms.source_id)=d.id AND ms.eligible=1 AND ms.tombstone=0)";
const configuration = (c: EmbeddingConfig) =>
  JSON.stringify([c.id, c.embedding_model || modelDefault]);
export function searchStatus(owner: string) {
  const preference = db
    .prepare("SELECT * FROM preferences WHERE owner_id=?")
    .get(owner) as QueryRow<"preferences"> | undefined;
  if (!preference?.embedding_enabled)
    return {
      enabled: false,
      state: "disabled",
      total: 0,
      indexed: 0,
      pending: 0,
      detail: "Semantic search is off. Keyword search is available.",
    };
  const c = embeddingConfig(owner);
  const counts = db
    .prepare(
      `SELECT count(*) AS total,coalesce(sum(CASE WHEN e.model=? THEN 1 ELSE 0 END),0) AS indexed
    FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id AND e.owner_id=d.owner_id
    WHERE d.owner_id=? AND ${eligibleText}`,
    )
    .get(c?.embedding_model || modelDefault, owner) as {
    total: number;
    indexed: number;
  };
  const pending = counts.total - counts.indexed;
  const status = db
    .prepare(
      "SELECT * FROM search_index_status WHERE owner_id=? AND configuration=?",
    )
    .get(owner, c ? configuration(c) : "") as
    QueryRow<"search_index_status"> | undefined;
  const state = !c
    ? "needs_connection"
    : !pending
      ? "ready"
      : status?.state === "error"
        ? "error"
        : counts.indexed
          ? "indexing"
          : "preparing";
  const detail =
    state === "needs_connection"
      ? "Reconnect the embedding account in Search preferences. Keyword search is available."
      : state === "error"
        ? status!.error
        : state === "ready"
          ? `Semantic search is ready. ${counts.indexed} items indexed.`
          : counts.indexed
            ? `Building the search index: ${counts.indexed} of ${counts.total} items ready.`
            : c?.embedding_model === localModel
              ? "Preparing semantic search. The first model download and indexing can take a few minutes. Keyword search is available now."
              : "Preparing semantic search with the selected API account. Keyword search is available while your content is indexed.";
  return { enabled: true, state, ...counts, pending, detail };
}
export async function embed(c: EmbeddingConfig, text: string[]) {
  if (c.local) return localEmbeddings(text);
  const connection = ownedConnection(c.id, c.owner_id);
  if (c.embedding_model === localModel) return localEmbeddings(text);
  const result = await new OpenAI({
    apiKey: unseal(requireSealedSecret(connection), connection.owner_id),
    maxRetries: 0,
    timeout: 20000,
  }).embeddings.create({
    model: c.embedding_model || modelDefault,
    input: text.map((x) => x.slice(0, 14000)),
  });
  return result.data.map((x) => x.embedding);
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return dot / (Math.sqrt(aa * bb) || 1);
}
let indexActive = false,
  lastIndexAttempt = 0;
export async function indexPending() {
  if (indexActive || now() - lastIndexAttempt < 5000) return;
  indexActive = true;
  lastIndexAttempt = now();
  try {
    const owners = db
      .prepare("SELECT owner_id FROM preferences WHERE embedding_enabled=1")
      .all() as { owner_id: string }[];
    for (const { owner_id } of owners) {
      const c = embeddingConfig(owner_id);
      if (!c) continue;
      const previous = db
        .prepare(
          "SELECT * FROM search_index_status WHERE owner_id=? AND configuration=?",
        )
        .get(owner_id, configuration(c)) as
        QueryRow<"search_index_status"> | undefined;
      if (previous?.state === "error" && now() - previous.updated_at < 30000)
        continue;
      const status = (state: string, error: string | null = null) =>
        db
          .prepare(
            "INSERT OR REPLACE INTO search_index_status VALUES(?,?,?,?,?)",
          )
          .run(owner_id, configuration(c), state, error, now());
      const docs = db
        .prepare(
          `SELECT d.* FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id WHERE d.owner_id=? AND (e.document_id IS NULL OR e.model<>?) AND ${eligibleText} AND d.updated_at<? ORDER BY d.updated_at,d.id LIMIT 16`,
        )
        .all(
          owner_id,
          c.embedding_model || modelDefault,
          now() - 5000,
        ) as SearchDoc[];
      if (!docs.length) {
        status("ready");
        continue;
      }
      status("indexing");
      try {
        const vectors = await embed(
          c,
          docs.map((d) => d.title + "\n" + d.content),
        );
        if (
          vectors.length !== docs.length ||
          vectors.some(
            (vector) =>
              !Array.isArray(vector) ||
              !vector.length ||
              vector.some((value) => !Number.isFinite(value)),
          )
        )
          throw new Error("Invalid embedding response");
        db.transaction(() =>
          docs.forEach((d, i) => {
            const current = db
              .prepare(
                "SELECT * FROM search_documents WHERE id=? AND owner_id=?",
              )
              .get(d.id, owner_id) as SearchDoc | undefined;
            const live = embeddingConfig(owner_id);
            if (
              current &&
              live?.id === c.id &&
              live.embedding_model === c.embedding_model &&
              hash(current) === hash(d)
            )
              db.prepare(
                "INSERT OR REPLACE INTO embeddings VALUES(?,?,?,?,?,?)",
              ).run(
                d.id,
                owner_id,
                c.embedding_model || modelDefault,
                JSON.stringify(vectors[i]),
                hash(d),
                now(),
              );
          }),
        )();
        status("ready");
      } catch (error) {
        status(
          "error",
          error instanceof InvalidRow
            ? error.message
            : c.embedding_model === localModel
              ? "Local semantic indexing failed. Loop will retry automatically; keyword search is available."
              : "The embedding provider could not index your content. Check the API account in Search preferences; keyword search is available.",
        );
      }
    }
  } finally {
    indexActive = false;
  }
}
function filterSql(owner: string, filters: SearchFilters) {
  const clauses = [
      "d.owner_id=?",
      `NOT EXISTS(SELECT 1 FROM artifacts a WHERE 'artifact:'||a.id=d.id AND a.owner_id=d.owner_id AND COALESCE(${traceArtifactSql},0))`,
    ],
    params: any[] = [owner];
  for (const [key, column] of [
    ["agent", "agent_id"],
    ["folder", "folder_id"],
    ["kind", "kind"],
  ] as const) {
    if (filters[key]) {
      clauses.push(`d.${column}=?`);
      params.push(filters[key]);
    }
  }
  // A project and its subfolders. Messages are indexed without a folder, so
  // theirs comes from the conversation: its project, else its latest run's.
  if (filters.folders) {
    clauses.push(
      `EXISTS(SELECT 1 FROM json_each(?) WHERE value IS COALESCE(d.folder_id,(SELECT COALESCE(c.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)) FROM conversations c WHERE c.id=d.conversation_id AND c.owner_id=d.owner_id)))`,
    );
    params.push(JSON.stringify(filters.folders));
  }
  if (filters.from) {
    clauses.push("d.created_at>=?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("d.created_at<=?");
    params.push(filters.to);
  }
  if (filters.scope === "mine")
    clauses.push(
      "EXISTS(SELECT 1 FROM messages m WHERE 'message:'||m.id=d.id AND m.owner_id=d.owner_id AND m.role='user')",
    );
  if (filters.scope === "running")
    clauses.push(
      "EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=d.owner_id AND r.agent_id=d.agent_id AND r.state IN ('running','pausing') AND r.worker_id IS NOT NULL)",
    );
  return { sql: clauses.join(" AND "), params };
}
export function lexical(owner: string, q: string, filters: SearchFilters = {}) {
  const filter = filterSql(owner, filters);
  const terms = q.match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return [] as (SearchDoc & { rank: number })[];
  const match = terms
    .slice(0, 20)
    .map((t) => '"' + t + '"')
    .join(" OR ");
  return db
    .prepare(
      `SELECT d.*,bm25(search_fts) rank FROM search_fts JOIN search_documents d ON d.id=search_fts.id WHERE search_fts MATCH ? AND ${filter.sql} ORDER BY rank LIMIT 300`,
    )
    .all(match, ...filter.params) as (SearchDoc & { rank: number })[];
}
export type SearchFilters = {
  agent?: string;
  folder?: string;
  /** Folders of one project (see projectFolders). */
  folders?: (string | null)[];
  kind?: string;
  from?: number;
  to?: number;
  scope?: string;
  before?: number;
};
export async function search(
  owner: string,
  q: string,
  filters: SearchFilters = {},
) {
  const scores = new Map<string, number>(),
    docs = new Map<string, SearchDoc>();
  const words = lexical(owner, q, filters);
  words.forEach((d, i) => {
    scores.set(d.id, 1 / (60 + i));
    docs.set(d.id, d);
  });
  const c = embeddingConfig(owner);
  const semantic = searchStatus(owner);
  let mode = "keyword",
    detail = semantic.detail;
  // Do not make users wait for a second model download when there is no
  // indexed content to compare their query with yet.
  if (c && semantic.indexed > 0) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let vectors: number[][];
      try {
        vectors = await Promise.race([
          embed(c, [q]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Semantic query timed out")),
              4000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const [vector] = vectors;
      const filter = filterSql(owner, filters);
      const rows = db
        .prepare(
          `SELECT d.*,e.vector FROM embeddings e JOIN search_documents d ON d.id=e.document_id WHERE e.owner_id=? AND ${filter.sql} AND e.model=? AND ${eligibleText}`,
        )
        .all(
          owner,
          ...filter.params,
          c.embedding_model || modelDefault,
        ) as (SearchDoc & {
        vector: string;
      })[];
      rows
        .map((d) => ({ doc: d, score: cosine(vector, JSON.parse(d.vector)) }))
        .filter((x) => x.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 300)
        .forEach(({ doc }, i) => {
          scores.set(doc.id, (scores.get(doc.id) || 0) + 1 / (60 + i));
          docs.set(doc.id, doc);
        });
      mode = "hybrid";
      detail =
        c.embedding_model === localModel
          ? "Keyword + semantic results. Text stays on your Loop server."
          : "Keyword + semantic results. Embeddings and this query go to your selected OpenAI API account.";
    } catch (error) {
      if (error instanceof InvalidRow)
        db.prepare(
          "INSERT OR REPLACE INTO search_index_status VALUES(?,?,?,?,?)",
        ).run(owner, configuration(c), "error", error.message, now());
      detail = "Semantic service unavailable; showing keyword results.";
    }
  }
  const offset = Math.max(0, Math.min(filters.before || 0, 10000));
  // Both retrieval paths apply filterSql before ranking.
  let result = [...docs.values()];
  result.sort(
    (a, b) =>
      (scores.get(b.id) || 0) - (scores.get(a.id) || 0) ||
      b.created_at - a.created_at ||
      a.id.localeCompare(b.id),
  );
  // Hide only the message representation of a matching, explicitly linked
  // assistant artifact. Keep distinct files, repeated messages and saved edits.
  const artifactIds = result
    .filter((d) => d.id.startsWith("artifact:"))
    .map((d) => d.id.slice(9));
  const representedMessages = new Set(
    (
      db
        .prepare(
          `SELECT 'message:'||m.id AS id FROM artifacts a
      JOIN messages m ON (m.id=json_extract(a.metadata,'$.messageId') OR (a.run_id IS NOT NULL AND m.run_id=a.run_id))
        AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id
        AND m.role='assistant' AND json_extract(m.metadata,'$.progress') IS NOT 1 AND trim(replace(m.content,char(13),''))=trim(replace(a.content,char(13),''))
      WHERE a.owner_id=? AND a.id IN (SELECT value FROM json_each(?))`,
        )
        .all(owner, JSON.stringify(artifactIds)) as { id: string }[]
    ).map((row) => row.id),
  );
  result = result.filter((d) => !representedMessages.has(d.id));
  return {
    mode,
    detail,
    pending: semantic.pending,
    semantic,
    next: result.length > offset + 30 ? offset + 30 : null,
    items: result.slice(offset, offset + 30).map((d) => {
      const messageId = d.id.startsWith("message:")
        ? d.id.slice(8)
        : (
            db
              .prepare(
                `SELECT m.id AS message_id FROM artifacts a
                 JOIN messages m ON (m.id=json_extract(a.metadata,'$.messageId') OR (a.run_id IS NOT NULL AND m.run_id=a.run_id))
                   AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id
                   AND m.role='assistant' AND json_extract(m.metadata,'$.progress') IS NOT 1 AND trim(replace(m.content,char(13),''))=trim(replace(a.content,char(13),''))
                 WHERE a.id=? AND a.owner_id=?`,
              )
              .get(d.id.slice(9), owner) as { message_id: string } | undefined
          )?.message_id;
      const agent = d.agent_id
        ? db
            .prepare(
              "SELECT name,provider FROM agents WHERE id=? AND owner_id=?",
            )
            .get(d.agent_id, owner)
        : {};
      return {
        ...d,
        ...(agent as object),
        content: undefined,
        snippet: searchExcerpt(d.content, d.title, q),
        message_id: messageId || null,
        score: scores.get(d.id),
        url: messageId
          ? `/?conversation=${d.conversation_id}&message=${messageId}`
          : `/?artifact=${d.id.slice(9)}`,
      };
    }),
  };
}
