import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";

import { runResponse } from "./row-schemas.js";
import { projectionSnapshot } from "./projection-snapshot.js";
import { feedProjection } from "./feed-projection.js";
import { setReplyState } from "./steering-replies.js";
import type { z } from "zod";
import { teamFilter } from "./teams.js";
import { listDoneThreads, readDoneThread, createDoneThread, moveDoneThreadCards, removeDoneThread } from "./done-threads.js";
import { listAgentThreads, readAgentThread } from "./agent-thread-feed.js";
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
routes.on(workspaceApi.doneThreadList, (req, res) => res.json(listDoneThreads(res.locals.owner, req.query)));
routes.on(workspaceApi.agentThreadFeed, (req, res) => res.json(listAgentThreads(res.locals.owner, req.query)));
routes.on(workspaceApi.agentThreadDetail, (req, res) => res.json(readAgentThread(res.locals.owner, req.params.id, req.query)));
routes.on(workspaceApi.doneThreadDetail, (req, res) => res.json(readDoneThread(res.locals.owner, req.params.id)));
routes.on(workspaceApi.doneThreadCreate, (req, res) => res.json(createDoneThread(res.locals.owner, req.body)));
routes.on(workspaceApi.doneThreadMove, (req, res) => res.json(moveDoneThreadCards(res.locals.owner, req.params.id, req.body.cardIds)));
routes.on(workspaceApi.doneThreadRemove, (req, res) => res.json(removeDoneThread(res.locals.owner, req.params.id)));
routes.on(workspaceApi.doneThreadRemoveCard, (req, res) => res.json(removeDoneThread(res.locals.owner, req.params.id, req.params.card)));
routes.on(workspaceApi.conversationPosition, (req, res) =>
  res.json(savePosition(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.feed, (req, res) => {
  const { known, ...query } = req.query;
  const selection = { ...query, teams: teamFilter(query.teams, res.locals.owner) };
  const page = feed(res.locals.owner, selection);
  res.json(feedProjection(res.locals.owner, selection, page, known));
}, { wrap: projectionSnapshot });
routes.on(workspaceApi.feedUpdate, (req, res) =>
  res.json(setDoneCardHidden(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.replyState, (req, res) =>
  res.json(setReplyState(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.feedAway, (req, res) =>
  res.json(
    awaySummary(res.locals.owner, req.query.since),
  ),
);
routes.on(workspaceApi.messageSave, (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, true)),
);
routes.on(workspaceApi.messageUnsave, (req, res) =>
  res.json(setSaved(res.locals.owner, req.params.id, false)),
);
routes.on(workspaceApi.savedList, (req, res) =>
  res.json(
    listSaved(res.locals.owner, {
      before: req.query.before,
      folder: req.query.folder,
      teams: teamFilter(req.query.teams, res.locals.owner),
      q: req.query.q,
    }) as z.input<typeof workspaceApi.savedList.response>,
  ),
);
routes.on(workspaceApi.savedLabel, (req, res) =>
  res.json(setSavedLabel(res.locals.owner, req.body)),
);
routes.on(workspaceApi.conversationOutline, (req, res) =>
  res.json(
    conversationOutline(
      res.locals.owner,
      req.params.id,
      req.query.q,
    ),
  ),
);
routes.on(workspaceApi.laterCreate, (req, res) =>
  res.status(201).json(createLater(res.locals.owner, req.body)),
);
routes.on(workspaceApi.laterList, (_req, res) => res.json(listLater(res.locals.owner)));
routes.on(workspaceApi.laterFinish, (req, res) =>
  res.json(finishLater(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.laterSnooze, (req, res) =>
  res.json(snoozeLater(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.laterReopen, (req, res) =>
  res.json(reopenLater(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.projectOpened, (req, res) =>
  res.json(projectOpened(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.projectSummaries, (_req, res) =>
  res.json(projectSummaries(res.locals.owner)),
);
routes.on(workspaceApi.scheduledSendCreate, (req, res) => {
  const { created, row } = createScheduledSend(res.locals.owner, req.body);
  res.status(created ? 201 : 200).json(row);
});
routes.on(workspaceApi.scheduledSendList, (req, res) =>
  res.json(
    listScheduledSends(
      res.locals.owner,
      req.query.conversation,
      req.query.failedBefore,
    ) as z.input<typeof workspaceApi.scheduledSendList.response>,
  ),
);
routes.on(workspaceApi.scheduledSendCancel, (req, res) =>
  res.json(cancelScheduledSend(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.scheduledSendUpdate, (req, res) =>
  res.json(editScheduledSend(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.scheduledSendRetry, (req, res) => {
  const result = retryScheduledSend(res.locals.owner, req.params.id);
  res.json({ ...result, run: result.run ? runResponse(result.run) : null });
});
routes.on(workspaceApi.runReorder, (req, res) =>
  res.json(reorderRun(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.runUpdate, (req, res) =>
  res.json(editQueuedRun(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.runWithdraw, (req, res) =>
  res.json(withdrawQueuedRun(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.runMove, (req, res) =>
  res.status(202).json(runResponse(moveQueuedRun(res.locals.owner, req.params.id, req.body))),
);
routes.on(workspaceApi.conversationFork, (req, res) =>
  res.json(forkConversation(res.locals.owner, req.params.id, req.body)),
);
routes.on(workspaceApi.conversationUsage, (req, res) =>
  res.json(conversationUsage(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.snippetList, (_req, res) => res.json(listSnippets(res.locals.owner) as z.input<typeof workspaceApi.snippetList.response>));
