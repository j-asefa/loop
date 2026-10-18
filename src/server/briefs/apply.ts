import { db, id, now } from "../db.js";
import {
  Output,
  OutputItem,
  Headline,
  ItemSummary,
  type Cite,
  type Change,
  type ValidationError,
} from "./schema.js";
import { checkQuote, resolveCite, type ResolvedCite } from "./cites.js";
import {
  active,
  assertProject,
  conversationProject,
  ledger,
  readState,
  section,
  selectView,
  type LedgerItem,
  type View,
} from "./store.js";

const prefixes = {
  state: "st_",
  decision: "dec_",
  question: "q_",
  unfinished: "un_",
} as const;
const fields: Record<string, string[]> = {
  state: ["id", "kind", "text", "cite", "status"],
  decision: [
    "id",
    "kind",
    "text",
    "cite",
    "status",
    "why",
    "evidence",
    "decided_by",
    "supersedes",
  ],
  question: [
    "id",
    "kind",
    "text",
    "cite",
    "status",
    "asked_by",
    "answered_cite",
  ],
  unfinished: [
    "id",
    "kind",
    "text",
    "cite",
    "status",
    "thread",
    "next",
    "blocker",
  ],
};
for (const names of Object.values(fields)) names.push("summary");
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Recoverable model mistakes are normalized before the strict tool schema. */
export function normalizeOutput(input: unknown, existing: LedgerItem[] = []) {
  const errors: ValidationError[] = [];
  const originalQuotes = new WeakMap<Cite, string>();
  const rememberQuotes = (normalized: Cite[], raw: unknown) => {
    if (!Array.isArray(raw)) return;
    normalized.forEach((cite, index) => {
      const quote = raw[index]?.quote;
      if (typeof quote === "string" && quote.length > 300)
        originalQuotes.set(cite, quote);
    });
  };
  const error = (code: ValidationError["code"], id: string, message: string) =>
    errors.push({ code, id, message });
  const bounded = (value: any, max: number, key: string, item: string) => {
    if (typeof value === "string" && value.length > max) {
      error("bound_exceeded", item, `${key} exceeds ${max} characters`);
      // A quote remains a literal excerpt, so only authored prose gets ellipsis.
      return key === "quote"
        ? value.slice(0, max)
        : value.slice(0, max - 1) + "…";
    }
    return value;
  };
  const cites = (value: any, item: string) =>
    Array.isArray(value)
      ? value.map((cite) =>
          object(cite)
            ? {
                ref: cite.ref,
                ...(cite.quote !== undefined && {
                  quote: bounded(cite.quote, 300, "quote", item),
                }),
              }
            : cite,
        )
      : value;
  try {
    if (typeof input === "string") input = JSON.parse(input);
  } catch {
    input = null;
  }
  if (
    !object(input) ||
    !Array.isArray(input.items) ||
    !object(input.headline)
  ) {
    error(
      "invalid_output",
      "",
      "Expected a JSON object with headline and items",
    );
    return { output: null, errors, submitted: 0 };
  }
  for (const key of Object.keys(input))
    if (!["headline", "items"].includes(key))
      error("derived_field", "", `Ignored ${key}`);
  for (const key of Object.keys(input.headline))
    if (!["text", "update", "cite"].includes(key))
      error("derived_field", "headline", `Ignored ${key}`);
  const headline = Headline.safeParse({
    text: bounded(input.headline.text, 140, "headline", "headline"),
    ...(input.headline.update !== undefined && {
      update: input.headline.update,
    }),
    cite: cites(input.headline.cite, "headline"),
  });
  if (!headline.success) {
    error("invalid_output", "headline", headline.error.message);
    return { output: null, errors, submitted: input.items.length };
  }
  const items: Output["items"] = [];
  rememberQuotes(headline.data.cite, input.headline.cite);
  const rewritten = new Set<Output["items"][number]>();
  for (const value of input.items) {
    if (
      !object(value) ||
      typeof value.kind !== "string" ||
      !Object.hasOwn(fields, value.kind)
    ) {
      error("invalid_output", "", "Unknown item kind");
      continue;
    }
    const key = typeof value.id === "string" ? value.id : "";
    const item = Object.fromEntries(
      Object.entries(value).filter(([k]) => fields[value.kind].includes(k)),
    );
    for (const name of Object.keys(value))
      if (!fields[value.kind].includes(name))
        error("derived_field", key, `Ignored ${name}`);
    for (const name of ["text", "why", "next", "blocker"])
      if (item[name] !== undefined)
        item[name] = bounded(
          item[name],
          name === "next" || name === "blocker" ? 200 : 240,
          name,
          key,
        );
    item.cite = cites(item.cite, key);
    if (item.summary !== undefined) {
      // Do not truncate the reading layer: a cut sentence can lose a caveat.
      const summary = ItemSummary.safeParse(item.summary);
      if (!summary.success) {
        error(
          "invalid_output",
          key,
          "Invalid reading summary: " + summary.error.message,
        );
        delete item.summary;
      } else item.summary = summary.data;
    }
    if (item.answered_cite)
      item.answered_cite = cites([item.answered_cite], key)[0];
    // Omitting a field does not erase a choice's already recorded evidence.
    // Revalidate that evidence against the proposed citations below.
    if (item.kind === "decision" && item.evidence === undefined && item.id)
      item.evidence = existing.find(
        (old) => old.id === item.id && old.kind === "decision",
      )?.evidence;
    const withoutEvidence = item.kind === "decision" && !item.evidence;
    if (withoutEvidence) {
      error(
        "decision_without_evidence",
        key,
        "A recommendation without evidence is a question",
      );
      const question = {
        kind: "question",
        text: item.text,
        cite: item.cite,
        asked_by: item.decided_by || "model",
        status: "open",
      };
      Object.keys(item).forEach((k) => delete item[k]);
      Object.assign(item, question);
    }
    const parsed = OutputItem.safeParse(item);
    if (parsed.success) {
      rememberQuotes(parsed.data.cite, value.cite);
      if (parsed.data.kind === "question" && parsed.data.answered_cite)
        rememberQuotes([parsed.data.answered_cite], [value.answered_cite]);
      items.push(parsed.data);
      if (withoutEvidence) rewritten.add(parsed.data);
    } else error("invalid_output", key, parsed.error.message);
  }
  return {
    output: { headline: headline.data, items },
    errors,
    submitted: input.items.length,
    rewritten,
    originalQuotes,
  };
}
function checkCites(
  owner: string,
  project: string,
  cites: Cite[],
  item: string,
  errors: ValidationError[],
  originalQuotes?: WeakMap<Cite, string>,
) {
  const resolved: ResolvedCite[] = [];
  if (!cites.length)
    errors.push({
      code: "cite_unresolved",
      id: item,
      message: "At least one citation is required",
    });
  for (const cite of cites) {
    const source = resolveCite(owner, project, cite);
    if (!source)
      errors.push({
        code: "cite_unresolved",
        id: item,
        message: `Cannot resolve ${cite.ref} in this project`,
      });
    else if (
      !checkQuote(source.content, originalQuotes?.get(cite) ?? cite.quote)
    )
      errors.push({
        code: "quote_not_contained",
        id: item,
        message: `Quote is not contained in ${cite.ref}`,
      });
    else resolved.push(source);
  }
  return resolved;
}
function evidenceMatches(
  evidence: string,
  sources: ResolvedCite[],
  previous: ResolvedCite[],
  ownerAuthored = false,
) {
  if (evidence === "owner_message")
    return sources.some(
      (s) => s.kind === "message" && s.role === "user" && !s.automated,
    );
  if (evidence === "owner_saved")
    return sources.some(
      (s) =>
        s.kind === "saved" || (ownerAuthored && s.kind === "result" && s.saved),
    );
  if (evidence === "approval")
    return sources.some(
      (s) =>
        s.kind === "approval" &&
        ["approved", "executing", "completed"].includes(s.state ?? ""),
    );
  if (evidence === "merge")
    return sources.some((s) => s.kind === "pr" && s.merged);
  const proposal =
    previous.find((s) => s.kind === "result" && s.recordedAt !== undefined) ??
    sources.find((s) => s.kind === "result" && s.recordedAt !== undefined);
  return (
    !!proposal &&
    sources.some(
      (s) =>
        s.kind === "result" &&
        s.runId &&
        s.runId !== proposal.runId &&
        s.runCreatedAt !== undefined &&
        s.runCreatedAt > proposal.recordedAt!,
    )
  );
}
function comparable(item: LedgerItem) {
  const { first_version, last_version, created_at, updated_at, ...content } =
    item;
  // Object property insertion order is not authored content.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(content)
        .filter(([, value]) => value !== null)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export type ApplyBasis = {
  builtOnVersion: number;
  ownerEditRev: number;
  basisThrough: number;
};
export type ApplyResult =
  | { outcome: "published"; version: number; errors: ValidationError[] }
  | { outcome: "discarded"; reason: string }
  | {
      outcome: "unchanged" | "duplicate" | "failed";
      errors: ValidationError[];
    };

export function applyOutput(
  owner: string,
  project: string,
  input: unknown,
  basis: ApplyBasis,
): ApplyResult {
  for (const value of Object.values(basis))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid brief basis");
  try {
    return db
      .transaction((): ApplyResult => {
        assertProject(owner, project);
        const state = readState(owner, project),
          key = `brief:${project}:${basis.basisThrough}`;
        // A completed attempt is idempotent even when its original CAS basis is old.
        if (
          db
            .prepare(
              "SELECT 1 FROM project_briefs WHERE owner_id=? AND project_id=? AND idempotency_key=?",
            )
            .get(owner, project, key)
        )
          return { outcome: "duplicate", errors: [] };
        if (state.current_version !== basis.builtOnVersion)
          return {
            outcome: "discarded",
            reason: "A newer brief was published",
          };
        if (state.owner_edit_rev !== basis.ownerEditRev)
          return {
            outcome: "discarded",
            reason: "The owner edited this brief",
          };
        // An unchanged pass has no version row; its advanced cursor is its receipt.
        if (
          basis.basisThrough > 0 &&
          basis.basisThrough === state.basis_through
        )
          return { outcome: "duplicate", errors: [] };
        if (basis.basisThrough < state.basis_through)
          return {
            outcome: "discarded",
            reason: "The basis cursor is older than the current brief",
          };
        const before = ledger(owner, project),
          normalized = normalizeOutput(input, before),
          errors = normalized.errors;
        if (!normalized.output) return { outcome: "failed", errors };
        const output = normalized.output,
          previous = new Map(before.map((r) => [r.id, r])),
          next = new Map(before.map((r) => [r.id, { ...r }]));
        const version = state.current_version + 1,
          time = now();
        const current = db
          .prepare(
            "SELECT view FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
          )
          .get(owner, project, state.current_version) as
          { view: string } | undefined;
        const oldView = current
          ? (JSON.parse(current.view) as View)
          : selectView(before, null);
        // Omitted items stay in the ledger and still have their citations checked.
        for (const row of before) {
          const count = errors.length;
          checkCites(
            owner,
            project,
            [
              ...row.cite,
              ...(row.answered_cite ? [row.answered_cite] : []),
              ...(row.summary?.request ? [row.summary.request] : []),
            ],
            row.id,
            errors,
          );
          next.set(row.id, { ...row, cite_stale: errors.length > count });
        }
        let accepted = 0;
        const seen = new Set<string>();
        for (const proposed of output.items) {
          const old = proposed.id ? previous.get(proposed.id) : undefined;
          const itemId = old?.id ?? prefixes[proposed.kind] + id();
          if (proposed.id && !old)
            errors.push({
              code: "unknown_id",
              id: proposed.id,
              message: "Unknown project item; allocated a fresh id",
            });
          if (seen.has(itemId) || (old && old.kind !== proposed.kind)) {
            errors.push({
              code: "invalid_output",
              id: itemId,
              message: "Item ids are unique and their kind is immutable",
            });
            continue;
          }
          seen.add(itemId);
          const count = errors.length;
          const sources = checkCites(
            owner,
            project,
            proposed.cite,
            itemId,
            errors,
            normalized.originalQuotes,
          );
          const request = old?.pinned
            ? old.summary?.request
            : proposed.summary?.request;
          if (request) {
            const resolved = checkCites(
              owner,
              project,
              [request],
              itemId,
              errors,
            )[0];
            if (
              !resolved ||
              resolved.kind !== "message" ||
              resolved.role !== "user" ||
              resolved.automated ||
              !request.quote?.trim()
            )
              errors.push({
                code: "evidence_mismatch",
                id: itemId,
                message:
                  "The original request must quote a real owner message in this project",
              });
          }
          const answerCite =
            proposed.kind === "question"
              ? proposed.answered_cite === undefined
                ? old?.answered_cite
                : proposed.answered_cite
              : undefined;
          if (answerCite)
            checkCites(
              owner,
              project,
              [answerCite],
              itemId,
              errors,
              normalized.originalQuotes,
            );
          if (
            proposed.kind === "unfinished" &&
            conversationProject(owner, proposed.thread) !== project
          )
            errors.push({
              code: "cite_unresolved",
              id: itemId,
              message: "Unfinished thread is outside this project",
            });
          if (errors.length > count) {
            if (old) {
              next.set(itemId, { ...old, cite_stale: true });
              accepted++;
            }
            continue;
          }
          if (
            proposed.kind === "decision" &&
            !evidenceMatches(
              proposed.evidence,
              sources,
              (old?.cite ?? []).flatMap(
                (c) => resolveCite(owner, project, c) ?? [],
              ),
              old?.author === "owner",
            )
          ) {
            errors.push({
              code: "evidence_mismatch",
              id: itemId,
              message: `Citations do not establish ${proposed.evidence}`,
            });
            if (old) accepted++;
            continue;
          }
          if (proposed.kind === "decision" && proposed.supersedes) {
            const target = next.get(proposed.supersedes);
            let ancestor = target;
            const ancestors = new Set<string>();
            while (
              ancestor &&
              ancestor.id !== itemId &&
              !ancestors.has(ancestor.id)
            ) {
              ancestors.add(ancestor.id);
              ancestor = ancestor.supersedes
                ? next.get(ancestor.supersedes)
                : undefined;
            }
            if (!target || target.kind !== "decision" || ancestor) {
              errors.push({
                code: "unknown_id",
                id: itemId,
                message:
                  "Supersedes must identify another decision in this project without a cycle",
              });
              if (old) accepted++;
              continue;
            }
          }
          const candidate: LedgerItem = {
            ...(old ?? {
              author: "model",
              pinned: false,
              owner_rev: 0,
              created_at: time,
              updated_at: time,
              first_version: version,
              last_version: version,
            }),
            ...proposed,
            id: itemId,
            cite_stale: false,
            status:
              proposed.status ??
              old?.status ??
              (proposed.kind === "state" || proposed.kind === "decision"
                ? "active"
                : "open"),
            ...(proposed.kind === "decision" && {
              decided_at: old?.decided_at ?? time,
            }),
            ...(proposed.kind === "question" &&
              normalized.rewritten?.has(proposed) && {
                asked_by:
                  sources.find((source) => source.kind === "result")?.agent ??
                  (sources.some(
                    (source) => source.role === "user" && !source.automated,
                  )
                    ? "you"
                    : sources.find((source) => source.agent)?.agent) ??
                  proposed.asked_by,
              }),
          };
          // An updated record must not keep an obsolete reading layer when an
          // older provider omits it. Pins retain exactly what the owner saw.
          if (!proposed.summary && !old?.pinned) delete candidate.summary;
          // Each submitted unfinished item describes its current obstacle.
          // Spreading the old record above must not resurrect a blocker that
          // the new brief deliberately omitted. Omitted items and pins retain
          // their recorded values.
          if (
            proposed.kind === "unfinished" &&
            proposed.blocker === undefined &&
            !old?.pinned
          )
            delete candidate.blocker;
          if (old?.pinned) {
            if (old.summary) candidate.summary = old.summary;
            else delete candidate.summary;
          }
          if (old?.pinned)
            for (const name of [
              "text",
              "why",
              "decided_by",
              "asked_by",
            ] as const) {
              if (candidate[name] !== old[name]) {
                errors.push({
                  code: "pinned_text_changed",
                  id: itemId,
                  message: `Restored pinned ${name}`,
                });
                if (old[name] === undefined) delete candidate[name];
                else candidate[name] = old[name];
              }
            }
          next.set(itemId, candidate);
          accepted++;
        }
        if (normalized.submitted > 0 && accepted === 0)
          return { outcome: "failed", errors };
        // Supersession is independent of model item order. Historical links on
        // reverted decisions do not force a reactivated predecessor back down.
        for (const item of next.values())
          if (item.kind === "decision" && active(item) && item.supersedes) {
            const target = next.get(item.supersedes);
            if (target && active(target))
              next.set(target.id, { ...target, status: "superseded" });
          }
        const headlineErrors = errors.length;
        checkCites(
          owner,
          project,
          output.headline.cite,
          "headline",
          errors,
          normalized.originalQuotes,
        );
        if (errors.length > headlineErrors && normalized.submitted === 0)
          return { outcome: "failed", errors };
        const headline =
          errors.length === headlineErrors ? output.headline : oldView.headline;
        const changes: Change[] = [];
        for (const [itemId, item] of next) {
          const old = previous.get(itemId);
          if (old && comparable(old) === comparable(item)) continue;
          next.set(itemId, {
            ...item,
            last_version: version,
            updated_at: time,
          });
          changes.push({
            op: !old
              ? "added"
              : active(old) && !active(item)
                ? ["answered", "done"].includes(item.status)
                  ? "resolved"
                  : "removed"
                : "changed",
            field: section[item.kind],
            id: itemId,
            since_version: version,
            pinned: item.pinned,
          });
        }
        const headlineChanged =
          JSON.stringify(headline) !== JSON.stringify(oldView.headline);
        if (headlineChanged)
          changes.push({
            op: oldView.headline ? "changed" : "added",
            field: "headline",
            id: "headline",
            since_version: version,
            pinned: false,
          });
        db.prepare(
          "INSERT OR IGNORE INTO brief_state(owner_id,project_id) VALUES(?,?)",
        ).run(owner, project);
        if (!changes.length) {
          db.prepare(
            "UPDATE brief_state SET basis_through=? WHERE owner_id=? AND project_id=?",
          ).run(basis.basisThrough, owner, project);
          return { outcome: "unchanged", errors };
        }
        const write =
          db.prepare(`INSERT INTO brief_items(id,owner_id,project_id,kind,text,summary,why,status,cites,evidence,decided_by,decided_at,supersedes,asked_by,answered_cite,thread_id,next,blocker,author,pinned,cite_stale,first_version,last_version,owner_rev,created_at,updated_at)
      VALUES(@id,@owner,@project,@kind,@text,@summary,@why,@status,@cites,@evidence,@decided_by,@decided_at,@supersedes,@asked_by,@answered_cite,@thread,@next,@blocker,@author,@pinned,@cite_stale,@first_version,@last_version,@owner_rev,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,summary=excluded.summary,why=excluded.why,status=excluded.status,cites=excluded.cites,evidence=excluded.evidence,decided_by=excluded.decided_by,decided_at=excluded.decided_at,supersedes=excluded.supersedes,asked_by=excluded.asked_by,answered_cite=excluded.answered_cite,thread_id=excluded.thread_id,next=excluded.next,blocker=excluded.blocker,pinned=excluded.pinned,cite_stale=excluded.cite_stale,last_version=excluded.last_version,updated_at=excluded.updated_at`);
        for (const item of next.values())
          if (!previous.has(item.id) || item.last_version === version) {
            write.run({
              owner,
              project,
              ...item,
              summary: item.summary ? JSON.stringify(item.summary) : null,
              why: item.why ?? null,
              evidence: item.evidence ?? null,
              decided_by: item.decided_by ?? null,
              decided_at: item.decided_at ?? null,
              supersedes: item.supersedes ?? null,
              asked_by: item.asked_by ?? null,
              answered_cite: item.answered_cite
                ? JSON.stringify(item.answered_cite)
                : null,
              thread: item.thread ?? null,
              next: item.next ?? null,
              blocker: item.blocker ?? null,
              cites: JSON.stringify(item.cite),
              pinned: Number(item.pinned),
              cite_stale: Number(item.cite_stale),
            });
          }
        const view = selectView([...next.values()], headline, changes);
        db.prepare(
          `INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,built_on_version,owner_edit_rev,state,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'published',?,?)`,
        ).run(
          id(),
          owner,
          project,
          version,
          JSON.stringify(view),
          state.basis_through,
          basis.basisThrough,
          time,
          basis.builtOnVersion,
          basis.ownerEditRev,
          key,
          time,
        );
        db.prepare(
          "UPDATE brief_state SET current_version=?,basis_through=? WHERE owner_id=? AND project_id=?",
        ).run(version, basis.basisThrough, owner, project);
        return { outcome: "published", version, errors };
      })
      .immediate();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "UNIQUE constraint failed: project_briefs.idempotency_key",
      )
    )
      return { outcome: "duplicate", errors: [] };
    throw error;
  }
}
