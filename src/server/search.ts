import OpenAI from "openai";
import { createHash } from "node:crypto";
import { db, now } from "./db.js";
import { unseal } from "./secrets.js";
import type { Connection } from "../shared/types.js";
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
function embeddingConfig(owner: string) {
  return db
    .prepare(
      "SELECT c.*,p.embedding_model FROM preferences p JOIN connections c ON c.id=p.embedding_connection AND c.owner_id=p.owner_id WHERE p.owner_id=? AND p.embedding_enabled=1 AND c.provider='openai' AND c.status='connected'",
    )
    .get(owner) as (Connection & { embedding_model: string }) | undefined;
}
export async function embed(
  c: Connection & { embedding_model?: string },
  text: string[],
) {
  const result = await new OpenAI({
    apiKey: unseal(c.secret, c.owner_id),
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
      const docs = db
        .prepare(
          "SELECT d.* FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id WHERE d.owner_id=? AND (e.document_id IS NULL OR e.model<>?) AND length(d.content)>0 AND d.updated_at<? LIMIT 16",
        )
        .all(
          owner_id,
          c.embedding_model || modelDefault,
          now() - 5000,
        ) as SearchDoc[];
      if (!docs.length) continue;
      try {
        const vectors = await embed(
          c,
          docs.map((d) => d.title + "\n" + d.content),
        );
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
      } catch {
        /* keyword search remains available; status exposes pending count */
      }
    }
  } finally {
    indexActive = false;
  }
}
function filterSql(owner: string, filters: SearchFilters) {
  const clauses = ["d.owner_id=?"],
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
      "EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=d.owner_id AND r.agent_id=d.agent_id AND r.state IN ('running','queued','pausing','paused','awaiting_approval'))",
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
  let mode = "keyword",
    detail = "Semantic search is off. Keywords stay on this server.";
  if (c) {
    try {
      const [vector] = await embed(c, [q]);
      const filter = filterSql(owner, filters);
      const rows = db
        .prepare(
          `SELECT d.*,e.vector FROM embeddings e JOIN search_documents d ON d.id=e.document_id WHERE e.owner_id=? AND ${filter.sql} AND e.model=?`,
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
        "Keyword + semantic results. Embeddings and this query go to your selected OpenAI API account.";
    } catch {
      detail = "Semantic service unavailable; showing keyword results.";
    }
  }
  const offset = Math.max(0, Math.min(filters.before || 0, 10000));
  let result = [...docs.values()].filter(
    (d) =>
      (!filters.agent || d.agent_id === filters.agent) &&
      (!filters.folder || d.folder_id === filters.folder) &&
      (!filters.kind || d.kind === filters.kind) &&
      (!filters.from || d.created_at >= filters.from) &&
      (!filters.to || d.created_at <= filters.to),
  );
  if (filters.scope === "mine")
    result = result.filter(
      (d) =>
        d.id.startsWith("message:") &&
        db
          .prepare(
            "SELECT 1 FROM messages WHERE id=? AND owner_id=? AND role='user'",
          )
          .get(d.id.slice(8), owner),
    );
  if (filters.scope === "running")
    result = result.filter(
      (d) =>
        d.agent_id &&
        db
          .prepare(
            "SELECT 1 FROM runs WHERE owner_id=? AND agent_id=? AND state IN ('running','queued','pausing','paused','awaiting_approval')",
          )
          .get(owner, d.agent_id),
    );
  result.sort(
    (a, b) =>
      (scores.get(b.id) || 0) - (scores.get(a.id) || 0) ||
      b.created_at - a.created_at ||
      a.id.localeCompare(b.id),
  );
  const pending = (
    db
      .prepare(
        "SELECT count(*) n FROM search_documents d LEFT JOIN embeddings e ON e.document_id=d.id WHERE d.owner_id=? AND e.document_id IS NULL",
      )
      .get(owner) as { n: number }
  ).n;
  return {
    mode,
    detail,
    pending,
    next: result.length > offset + 30 ? offset + 30 : null,
    items: result.slice(offset, offset + 30).map((d) => {
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
        snippet: d.content.slice(0, 360),
        score: scores.get(d.id),
        url: d.id.startsWith("message:")
          ? `/?conversation=${d.conversation_id}&message=${d.id.slice(8)}`
          : `/?artifact=${d.id.slice(9)}`,
      };
    }),
  };
}
