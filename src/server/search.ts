import { config } from "./config.js";
import { workspaceLink } from "../shared/workspace-links.js";
import * as searchFtsQueries from "./sql/search-fts.js";
import * as preferencesQueries from "./sql/preferences.js";
import * as searchIndexStatusQueries from "./sql/search-index-status.js";
import * as searchDocumentsQueries from "./sql/search-documents.js";
import * as embeddingsQueries from "./sql/embeddings.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as agentsQueries from "./sql/agents.js";

import { InvalidRow, requireSealedSecret } from "./row-schemas.js";
import { ownedConnection } from "./domain.js";
import { ftsQuery, searchExcerpt } from "../shared/search-excerpt.js";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { db, now } from "./db.js";
import { unseal } from "./secrets.js";

import { localEmbeddings, localModel } from "./local-embeddings.js";
type SearchDoc = {
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
const modelDefault = config.embeddingModel;
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
  const preference = preferencesQueries.owned(db, owner);
  if (preference?.embedding_enabled && !preference.embedding_connection)
    return {
      id: "local",
      owner_id: owner,
      embedding_model: localModel,
      local: true,
    };
  return preferencesQueries.embeddingConnection(db, owner);
}
// Bind semantic indexing to the selected connection and model.
const configuration = (c: EmbeddingConfig) =>
  JSON.stringify([c.id, c.embedding_model || modelDefault]);
export function searchStatus(owner: string) {
  const preference = preferencesQueries.owned(db, owner);
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
  const counts = searchDocumentsQueries.indexCounts(
    db,
    c?.embedding_model || modelDefault,
    owner,
  );
  const pending = counts.total - counts.indexed;
  const status = searchIndexStatusQueries.configured(
    db,
    owner,
    c ? configuration(c) : "",
  );
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
async function embed(c: EmbeddingConfig, text: string[]) {
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
function cosine(a: number[], b: number[]) {
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
    const owners = preferencesQueries.embeddingOwners(db);
    for (const { owner_id } of owners) {
      const c = embeddingConfig(owner_id);
      if (!c) continue;
      const previous = searchIndexStatusQueries.configured(
        db,
        owner_id,
        configuration(c),
      );
      if (previous?.state === "error" && now() - previous.updated_at < 30000)
        continue;
      const status = (state: string, error: string | null = null) =>
        searchIndexStatusQueries.replace(
          db,
          owner_id,
          configuration(c),
          state,
          error,
          now(),
        );
      const docs = searchDocumentsQueries.pendingIndex(
        db,
        owner_id,
        c.embedding_model || modelDefault,
        now() - 5000,
      );
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
            const current = searchDocumentsQueries.owned(db, d.id, owner_id);
            const live = embeddingConfig(owner_id);
            if (
              current &&
              live?.id === c.id &&
              live.embedding_model === c.embedding_model &&
              hash(current) === hash(d)
            )
              embeddingsQueries.replace(
                db,
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
export function lexical(owner: string, q: string, filters: SearchFilters = {}) {
  const match = ftsQuery(q);
  if (!match) return [] as (SearchDoc & { rank: number })[];
  return searchFtsQueries.lexical(db, owner, match, filters, now());
}
export type { SearchFilters } from "./sql/search-documents.js";
import type { SearchFilters } from "./sql/search-documents.js";
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
      const rows = embeddingsQueries.search(
        db,
        owner,
        filters,
        c.embedding_model || modelDefault,
        now(),
      );
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
        searchIndexStatusQueries.replace(
          db,
          owner,
          configuration(c),
          "error",
          error.message,
          now(),
        );
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
    artifactsQueries
      .representedSearchMessages(db, owner, JSON.stringify(artifactIds))
      .map((row) => row.id),
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
        : artifactsQueries.searchMessage(db, d.id.slice(9), owner)?.message_id;
      const agent = d.agent_id
        ? agentsQueries.ownedDisplay(db, d.agent_id, owner)
        : {};
      return {
        ...d,
        ...(agent as object),
        content: undefined,
        snippet: searchExcerpt(d.content, d.title, q),
        message_id: messageId || null,
        score: scores.get(d.id),
        url: messageId
          ? workspaceLink({
              conversation: d.conversation_id,
              message: messageId,
            })
          : workspaceLink({ artifact: d.id.slice(9) }),
      };
    }),
  };
}
