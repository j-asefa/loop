import { Router } from "express";
import { z } from "zod";
import { teamFilter } from "./teams.js";
import {
  FEED_FILTERS,
  awaySummary,
  cancelScheduledSend,
  editScheduledSend,
  retryScheduledSend,
  conversationOutline,
  conversationUsage,
  createLater,
  createScheduledSend,
  editQueuedRun,
  finishLater,
  forkConversation,
  feed,
  listSaved,
  listLater,
  listScheduledSends,
  listSnippets,
  savePosition,
  moveQueuedRun,
  projectOpened,
  projectSummaries,
  reopenLater,
  reorderRun,
  setSaved,
  setSavedLabel,
  setDoneCardHidden,
  snoozeLater,
  withdrawQueuedRun,
} from "./mobile-return.js";

// Return and defer routes for the phone workspace. Mounted before `core` so
// the specific /runs/:id/reorder and /runs/:id/move paths are not taken by
// core's generic /runs/:id/:action handler.
export const mobile = Router();
const timestamp = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

mobile.put("/conversations/:id/position", (req, res) =>
  res.json(savePosition(res.locals.owner, req.params.id, req.body)),
);
mobile.get("/feed", (req, res) => {
  const q = z
    .object({
      filter: z.enum(FEED_FILTERS).default("all"),
      folder: z.string().min(1).max(150).optional(),
      agent: z.string().min(1).max(150).optional(),
      before: z.string().min(1).max(512).optional(),
    })
    .parse(req.query);
  res.json(
    feed(res.locals.owner, {
      ...q,
      teams: teamFilter(req.query.teams, res.locals.owner),
    }),
  );
});
mobile.patch("/feed/:id", (req, res) =>
  res.json(setDoneCardHidden(res.locals.owner, req.params.id, req.body)),
);
mobile.get("/feed/away", (req, res) =>
  res.json(
    awaySummary(res.locals.owner, timestamp.default(0).parse(req.query.since)),
  ),
);
mobile.post("/messages/:id/saved", (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, true)),
);
mobile.delete("/messages/:id/saved", (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, false)),
);
mobile.get("/saved", (req, res) =>
  res.json(
    listSaved(res.locals.owner, {
      before: z.string().max(500).optional().parse(req.query.before),
      folder: z.string().max(150).optional().parse(req.query.folder),
      teams: teamFilter(req.query.teams, res.locals.owner),
      q: z.string().max(200).optional().parse(req.query.q),
    }),
  ),
);
mobile.put("/saved/label", (req, res) =>
  res.json(setSavedLabel(res.locals.owner, req.body)),
);
mobile.get("/conversations/:id/outline", (req, res) =>
  res.json(
    conversationOutline(
      res.locals.owner,
      req.params.id,
      z.string().max(200).optional().parse(req.query.q),
    ),
  ),
);
mobile.post("/later", (req, res) =>
  res.status(201).json(createLater(res.locals.owner, req.body)),
);
mobile.get("/later", (_req, res) => res.json(listLater(res.locals.owner)));
mobile.delete("/later/:id", (req, res) =>
  res.json(finishLater(res.locals.owner, req.params.id)),
);
mobile.post("/later/:id/snooze", (req, res) =>
  res.json(snoozeLater(res.locals.owner, req.params.id, req.body)),
);
mobile.post("/later/:id/reopen", (req, res) =>
  res.json(reopenLater(res.locals.owner, req.params.id)),
);
mobile.post("/projects/:id/opened", (req, res) =>
  res.json(projectOpened(res.locals.owner, req.params.id)),
);
mobile.get("/projects/summary", (_req, res) =>
  res.json(projectSummaries(res.locals.owner)),
);
mobile.post("/scheduled-sends", (req, res) => {
  const { created, row } = createScheduledSend(res.locals.owner, req.body);
  res.status(created ? 201 : 200).json(row);
});
mobile.get("/scheduled-sends", (req, res) =>
  res.json(
    listScheduledSends(
      res.locals.owner,
      z.string().min(1).max(150).optional().parse(req.query.conversation),
      z.string().max(500).optional().parse(req.query.failedBefore),
    ),
  ),
);
mobile.delete("/scheduled-sends/:id", (req, res) =>
  res.json(cancelScheduledSend(res.locals.owner, req.params.id)),
);
mobile.patch("/scheduled-sends/:id", (req, res) =>
  res.json(editScheduledSend(res.locals.owner, req.params.id, req.body)),
);
mobile.post("/scheduled-sends/:id/retry", (req, res) =>
  res.json(retryScheduledSend(res.locals.owner, req.params.id)),
);
mobile.post("/runs/:id/reorder", (req, res) =>
  res.json(reorderRun(res.locals.owner, req.params.id, req.body)),
);
mobile.patch("/runs/:id", (req, res) =>
  res.json(editQueuedRun(res.locals.owner, req.params.id, req.body)),
);
mobile.post("/runs/:id/withdraw", (req, res) =>
  res.json(withdrawQueuedRun(res.locals.owner, req.params.id, req.body)),
);
mobile.post("/runs/:id/move", (req, res) =>
  res.status(202).json(moveQueuedRun(res.locals.owner, req.params.id, req.body)),
);
mobile.post("/conversations/:id/fork", (req, res) =>
  res.json(forkConversation(res.locals.owner, req.params.id, req.body)),
);
mobile.get("/conversations/:id/usage", (req, res) =>
  res.json(conversationUsage(res.locals.owner, req.params.id)),
);
mobile.get("/snippets", (_req, res) => res.json(listSnippets(res.locals.owner)));
