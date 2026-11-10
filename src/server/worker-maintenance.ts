import { indexPending } from "./search.js";
import { captureMemory } from "./memory.js";
import { deliverNotifications } from "./notifications.js";
import { deliverWebhooks } from "./webhooks.js";
import { deliverScheduledSends, surfaceLater } from "./mobile-return.js";
import { pollWatches } from "./pr-watches.js";
import { refreshDueFeeds } from "./news.js";
import { runDueDigests } from "./feed-digests.js";
import { matchWatches } from "./feed-watches.js";
import { sweepAgentMail } from "./agent-mail.js";
import { reconcileCheckouts } from "./run-checkouts.js";
import { changes } from "./db.js";
import { reportBackgroundFailure } from "./background-failure.js";

export function reconcileWorkerCheckouts() {
  void reconcileCheckouts().catch((error) =>
    reportBackgroundFailure("checkouts.reconcile", error),
  );
}

export function startMaintenance(
  track: (job: Promise<unknown>) => void,
  heartbeat: () => void,
) {
  let stopping = false;
  const maintenanceTimers: ReturnType<typeof setInterval>[] = [];
  const cleanupController = new AbortController();
  let notifying = false;
  let maintenanceWake: ReturnType<typeof setImmediate> | undefined;
  let maintenanceDirty = false;
  const maintain = () => {
    if (stopping) return;
    if (notifying) {
      maintenanceDirty = true;
      return;
    }
    notifying = true;
    // Surface Later items and submit due scheduled messages before
    // delivery, so their pushes go out in the same pass.
    try {
      surfaceLater();
    } catch (error) {
      reportBackgroundFailure("later.surface", error);
    }
    try {
      deliverScheduledSends();
    } catch (error) {
      reportBackgroundFailure("scheduled-sends.deliver", error);
    }
    // Results of background delegations, and team messages whose task
    // ended before reading them.
    try {
      sweepAgentMail();
    } catch (error) {
      reportBackgroundFailure("mail.sweep", error);
    }
    const delivery = Promise.allSettled([
      deliverNotifications().catch((error) =>
        reportBackgroundFailure("notifications.deliver", error),
      ),
      deliverWebhooks(cleanupController.signal).catch((error) =>
        reportBackgroundFailure("webhooks.deliver", error),
      ),
    ]).finally(() => {
      notifying = false;
      if (maintenanceDirty) {
        maintenanceDirty = false;
        wakeMaintenance();
      }
    });
    track(delivery);
  };
  const wakeMaintenance = () => {
    if (stopping || maintenanceWake) return;
    maintenanceWake = setImmediate(() => {
      maintenanceWake = undefined;
      maintain();
    });
  };
  maintenanceTimers.push(setInterval(maintain, 3000));
  // Watched pull requests; each one is read about once a minute.
  maintenanceTimers.push(
    setInterval(() => {
      if (stopping) return;
      track(
        pollWatches().catch((error) =>
          reportBackgroundFailure("pr-watches.poll", error),
        ),
      );
    }, 15_000),
  );
  // Social feeds. Reading them here rather than when a page asks means
  // opening Social is served from the store, and stays fresh with the tab
  // closed. Digests and watches run once the reads have settled, so they
  // see what the pass brought in rather than what was there before it; the
  // whole sequence is one tracked job, so stopping waits for all of it.
  maintenanceTimers.push(
    setInterval(() => {
      if (stopping) return;
      const promise = refreshDueFeeds()
        .then(() => {
          try {
            runDueDigests();
          } catch (error) {
            reportBackgroundFailure("digests.run", error);
          }
          try {
            matchWatches();
          } catch (error) {
            reportBackgroundFailure("feed-watches.match", error);
          }
        })
        .catch((error) => reportBackgroundFailure("feeds.refresh", error));
      track(promise);
    }, 60_000),
  );
  maintenanceTimers.push(
    setInterval(() => {
      if (stopping) return;
      try {
        captureMemory();
      } catch (error) {
        reportBackgroundFailure("memory.capture", error);
      }
    }, 5000),
  );
  const health = setInterval(heartbeat, 5000);
  const index = setInterval(
    () =>
      void indexPending().catch((error) =>
        reportBackgroundFailure("search.index", error),
      ),
    5000,
  );

  const unsubscribe = changes.subscribe(null, (events) => {
    if (
      events.some(
        ({ type }) =>
          type.startsWith("agent_mail.") || type === "artifact.published",
      )
    )
      wakeMaintenance();
  });
  return () => {
    if (stopping) return;
    stopping = true;
    cleanupController.abort();
    maintenanceTimers.forEach(clearInterval);
    if (maintenanceWake) clearImmediate(maintenanceWake);
    clearInterval(health);
    clearInterval(index);
    unsubscribe();
  };
}
