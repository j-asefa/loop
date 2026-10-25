# Saved cards, retirement and phone notifications

Saved is now the **Saved** section of Later, holding saved results and saved
messages together; [Workspace](../workspace.md) describes it. Automatic result
storage still preserves conversation history, but does not add anything to Saved.
**Remove from Saved** keeps the result. Archiving a card from the results feed
does not remove it from Saved. Refreshes update the loaded list in place.

An agent profile has **Retire agent** and **Restore agent** actions. Retirement
removes the agent from active pickers and blocks new work, including automatic
routing and delegation. Already accepted work can finish; conversations, results,
files and bookmarks remain. **Settings → Manage agents → Retired agents** provides
access to retired profiles and restoration. A team manager must be restored before
it can accept a new message. Deleting a team preserves its agents and history.
Deletion uses one confirmation sheet, a bounded request and a retryable error state.

Enable **Settings → Notifications → Enable notifications** on each device.
On iPhone, first add Loop to the Home Screen and open it there. The system permission
request happens only after tapping Enable. This follows [WebKit's Home Screen Web
Push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
The app must be served over HTTPS (localhost is supported for development).

Choose **Needs you**, **Completed work**, **Reminders** and **Social watches**
independently on each device. Newly enabled devices start with only **Needs you**
on: approvals, native questions, paused, failed or interrupted work, and scheduled
messages that could not be sent. To receive only action alerts, leave the other
three choices off. Existing subscriptions keep all categories enabled until you
change them. Turning a category off discards its pending alerts; turning it back
on does not replay history. Feed cards remain available regardless of these choices.

With **Completed work** enabled, the worker sends encrypted Web Push when a new completed agent result is published,
including while the app is closed. Notifications include the agent name and result
title; tapping one opens that result. Earlier history, tool calls, imports and
uploaded files do not trigger result alerts. Subscriptions and durable delivery
receipts live in the workspace database; private VAPID and subscription keys use
Loop's existing encryption key. Preserve that key and the data volume on restart.
No third-party notification account or additional deployment secret is required.
`LOOP_PUSH_CONTACT` can optionally set the VAPID contact URL or `mailto:` address.

Delivery has a lease, bounded retries and duplicate-replacing notification tags.
Expired subscriptions are removed when a push service returns 404 or 410. Turning
notifications off removes this device's server subscription and browser subscription.

Regression coverage: `test/workspace-lifecycle.test.ts` checks saved pagination and
changes, retirement authorization and persistence, deletion, subscription isolation,
delivery retries and service-worker notification clicks. `npm run smoke:workspace`
checks the phone UI in Chromium and WebKit with an isolated database and a browser
subscription fixture. It sends no real pushes. Actual iPhone delivery requires the
user to grant notification permission on that phone.
