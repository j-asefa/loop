import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";

import { runResponse } from "./row-schemas.js";
import { projectionSnapshot } from "./projection-snapshot.js";

import { z } from "zod";
import { teamFilter } from "./teams.js";
import {
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
const routes = registrar("mobile");
export const mobile = routes.mount;
const timestamp = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

routes.legacy("PUT /conversations/:id/position", (req, res) =>
  res.json(savePosition(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.feed, (req, res) => {
  const selection = { ...req.query, teams: teamFilter(req.query.teams, res.locals.owner) };
  const page = feed(res.locals.owner, selection);
  res.json(page);
}, { wrap: projectionSnapshot });
routes.legacy("PATCH /feed/:id", (req, res) =>
  res.json(setDoneCardHidden(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("GET /feed/away", (req, res) =>
  res.json(
    awaySummary(res.locals.owner, timestamp.default(0).parse(req.query.since)),
  ),
);
routes.legacy("POST /messages/:id/saved", (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, true)),
);
routes.legacy("DELETE /messages/:id/saved", (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, false)),
);
routes.legacy("GET /saved", (req, res) =>
  res.json(
    listSaved(res.locals.owner, {
      before: z.string().max(500).optional().parse(req.query.before),
      folder: z.string().max(150).optional().parse(req.query.folder),
      teams: teamFilter(req.query.teams, res.locals.owner),
      q: z.string().max(200).optional().parse(req.query.q),
    }),
  ),
);
routes.legacy("PUT /saved/label", (req, res) =>
  res.json(setSavedLabel(res.locals.owner, req.body)),
);
routes.legacy("GET /conversations/:id/outline", (req, res) =>
  res.json(
    conversationOutline(
      res.locals.owner,
      req.params.id,
      z.string().max(200).optional().parse(req.query.q),
    ),
  ),
);
routes.legacy("POST /later", (req, res) =>
  res.status(201).json(createLater(res.locals.owner, req.body)),
);
routes.legacy("GET /later", (_req, res) => res.json(listLater(res.locals.owner)));
routes.legacy("DELETE /later/:id", (req, res) =>
  res.json(finishLater(res.locals.owner, req.params.id)),
);
routes.legacy("POST /later/:id/snooze", (req, res) =>
  res.json(snoozeLater(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("POST /later/:id/reopen", (req, res) =>
  res.json(reopenLater(res.locals.owner, req.params.id)),
);
routes.legacy("POST /projects/:id/opened", (req, res) =>
  res.json(projectOpened(res.locals.owner, req.params.id)),
);
routes.legacy("GET /projects/summary", (_req, res) =>
  res.json(projectSummaries(res.locals.owner)),
);
routes.legacy("POST /scheduled-sends", (req, res) => {
  const { created, row } = createScheduledSend(res.locals.owner, req.body);
  res.status(created ? 201 : 200).json(row);
});
routes.legacy("GET /scheduled-sends", (req, res) =>
  res.json(
    listScheduledSends(
      res.locals.owner,
      z.string().min(1).max(150).optional().parse(req.query.conversation),
      z.string().max(500).optional().parse(req.query.failedBefore),
    ),
  ),
);
routes.legacy("DELETE /scheduled-sends/:id", (req, res) =>
  res.json(cancelScheduledSend(res.locals.owner, req.params.id)),
);
routes.legacy("PATCH /scheduled-sends/:id", (req, res) =>
  res.json(editScheduledSend(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("POST /scheduled-sends/:id/retry", (req, res) => {
  const result = retryScheduledSend(res.locals.owner, req.params.id);
  res.json({ ...result, run: result.run ? runResponse(result.run) : null });
});
routes.legacy("POST /runs/:id/reorder", (req, res) =>
  res.json(reorderRun(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("PATCH /runs/:id", (req, res) =>
  res.json(editQueuedRun(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("POST /runs/:id/withdraw", (req, res) =>
  res.json(withdrawQueuedRun(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("POST /runs/:id/move", (req, res) =>
  res.status(202).json(runResponse(moveQueuedRun(res.locals.owner, req.params.id, req.body))),
);
routes.legacy("POST /conversations/:id/fork", (req, res) =>
  res.json(forkConversation(res.locals.owner, req.params.id, req.body)),
);
routes.legacy("GET /conversations/:id/usage", (req, res) =>
  res.json(conversationUsage(res.locals.owner, req.params.id)),
);
routes.legacy("GET /snippets", (_req, res) => res.json(listSnippets(res.locals.owner)));
