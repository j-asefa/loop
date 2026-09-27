# Design consistency pass

The approved September 26 design audit is implemented on `fix/design-consistency-pass`.

- Dialogs keep their heading and close control visible, use one content scroller, and return through nested views without accumulating browser Back entries. Conversation dismissal starts on the drag handle so reading gestures do not close the chat.
- Conversations use a larger reading area, consistent text and touch targets, local error/success feedback, a full-width model form, and compact options for transferring selected messages. Pending approvals can be opened inside the conversation.
- Feed headers, agent profiles, team selection and attention indicators are shorter. An agent directory searches all agents. Project/team scopes apply to the feed, agent strip, running tasks and attention counts and persist in the URL. Project feeds include descendant folders.
- Project pages keep Agents, Activity and Files in place. Browsing nested files preserves the parent project. Saved opens Recent by default and distinguishes folders from projects.
- Tool permissions have their own tab. Catalog search ranks exact products first, highlights familiar integrations by default and omits deprecated entries. Provider names are consistent, remote setup can be opened from a provider form, and pairing returns the selected machine to that form.
- Search filters are collapsible with date labels and removable chips. Snippets omit repeated headings, find the matching passage and highlight matching terms.
- Workflow cards edit names, prompts, review messages, output titles, roles and source steps. Reordering preserves earlier-step dependencies; advanced JSON remains available. Traces are grouped by run and keep terminal line breaks.
- The app explicitly uses the system font, selected controls expose their state, empty screens differ from loading/error states, Settings is grouped, and personal-mode installation guidance does not ask for a Loop login.

## Verification

```sh
npm run build
npm test
npm run test:native
npm run smoke:design
npm run smoke:browser
LOOP_BROWSER=webkit npm run smoke:browser
npm run smoke:companion
LOOP_BROWSER=webkit npm run smoke:companion
npm run smoke:journey
LOOP_BROWSER=webkit npm run smoke:journey
```

The design smoke script starts a disposable server with synthetic agents, projects, output, traces and approvals. It does not load `.env`, call real providers or save browser authentication. Chromium and WebKit exercise mobile navigation, dialog history, model selection, inline failures, approvals, project descendants, catalog search, provider setup, workflow editing, dark mode and narrow/wide layouts. Chromium also checks a real emulated touch scroll and handle dismissal.

Existing browser journeys cover onboarding, pairing links, import/share, offline recovery, subscriptions, remote runtimes, tool approvals and workspace isolation. Their selectors follow the revised navigation; the long-history dismissal fixture explicitly provides enough content to scroll in the larger reader. Closing a conversation preserves its parent route, and navigation persistence leaves pairing fragments intact until pairing consumes them.

Set `LOOP_DESIGN_SCREENSHOT_DIR` to retain screenshots; otherwise the script creates no browser artifacts. Temporary databases and processes are cleaned up after the run.

## Device follow-up

Browser coverage includes 360/390 px phone layouts and a desktop layout. Physical iOS/Android keyboard behavior, OS safe areas, dynamic text size, VoiceOver and native pairing still need a device pass. The audit's native-shell status-bar/background suggestion is deferred to that pass; this change does not alter the existing mobile configuration.
