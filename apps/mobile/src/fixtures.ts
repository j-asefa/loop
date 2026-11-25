export type FeedTab = "done" | "working" | "queued" | "replies";

export type NativeResultCard = {
  id: string;
  conversationId: string;
  tab: FeedTab;
  agentName: string;
  projectName: string;
  model: string;
  prompt: string;
  fallbackTitle: string;
  body: string;
  createdAt: number;
  saved: boolean;
  unread: boolean;
  statusLabel?: string;
};

export type QuickReplyOption = {
  id: string;
  label: string;
  hint: string;
  instruction: string;
};

export const QUICK_REPLIES: QuickReplyOption[] = [
  {
    id: "deeper",
    label: "Go deeper",
    hint: "Ask for concrete tradeoffs and edge cases",
    instruction:
      "Go one level deeper on the main tradeoffs, failure modes, and what you would change first.",
  },
  {
    id: "checklist",
    label: "Turn into checklist",
    hint: "Distill into an actionable step-by-step plan",
    instruction:
      "Turn this recommendation into a crisp 5-step execution checklist we can run this week.",
  },
  {
    id: "counter",
    label: "Steelman the opposite",
    hint: "Challenge the current recommendation",
    instruction:
      "Make the strongest argument against this recommendation and tell me what assumption would flip your answer.",
  },
  {
    id: "summary",
    label: "3-bullet summary",
    hint: "Tighten for quick sharing",
    instruction:
      "Compress the key takeaway into 3 sharp bullets I can share with the team.",
  },
];

const HOUR = 3_600_000;
const MINUTE = 60_000;

export function createInitialCards(now = Date.now()): NativeResultCard[] {
  return [
    // @willow's 4-card Done stack (newest first)
    {
      id: "willow-4",
      conversationId: "conv-willow",
      tab: "done",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Explore posts and comments for the feed",
      fallbackTitle: "Explore posts and comments for the feed",
      body:
        "## A quieter feed with stacked result cards\n\n" +
        "A session can be one stack, with each discrete answer tucked neatly behind the newest card. Keep decisions visible and let readers swipe straight to any earlier result.\n\n" +
        "- **Stack on Done:** Newest card sits on top with earlier cards peeking cleanly beneath it\n" +
        "- **120fps native carousel:** Flip left/right across every discrete result with haptic detents\n" +
        "- **Direct thread search:** Tap the search icon above and try **Hetzner**, **residency**, or **latency**\n\n" +
        "Send a reply below to watch a live simulated result card arrive in this stack.",
      createdAt: now - 5 * MINUTE,
      saved: false,
      unread: true,
    },
    {
      id: "willow-3",
      conversationId: "conv-willow",
      tab: "done",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Audit mobile feed latency and card ergonomics on a 390px phone screen.\n" +
        "Focus on keeping tool traces out of feed cards, making multi-turn results easy to browse without chat scrolling, and avoiding clipped titles or keyboard zoom bugs.",
      fallbackTitle: "Mobile reading ergonomics",
      body:
        "### Mobile reading ergonomics\n\n" +
        "Two changes made the biggest difference on a 390px viewport:\n\n" +
        "1. **Messages only in cards:** Keeping tool traces and exit codes out of feed cards cuts visual clutter by half — you read what the agent concluded, not terminal exhaust.\n" +
        "2. **Stacked discrete cards → native floating carousel:** Grouping multi-turn results from the same thread into a single stack keeps Done calm, while swiping left/right preserves every answer as its own saveable, searchable card.",
      createdAt: now - 1 * HOUR,
      saved: false,
      unread: true,
    },
    {
      id: "willow-2",
      conversationId: "conv-willow",
      tab: "done",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Can you break down EU data residency guarantees, Frankfurt vs Falkenstein latency, monthly egress pricing at 2 TB/month, and how Hetzner + Bunny CDN compares against Fly.io and Render for a small team?",
      fallbackTitle: "EU data residency and Bunny CDN monthly costs",
      body:
        "EU data residency stays cleanly in Frankfurt/Falkenstein with **Hetzner + Bunny CDN** (~€38/month total at 2 TB egress), versus ~€61/month on Fly.io.\n\n" +
        "```spec\n" +
        '{"op":"add","path":"/root","value":"card"}\n' +
        '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Monthly EU cost breakdown"},"children":["tbl","acts"]}}\n' +
        '{"op":"add","path":"/elements/tbl","value":{"type":"Table","props":{"columns":["Provider","Compute","CDN / Egress","Total / mo"],"rows":[["Hetzner + Bunny CDN","€24","€14","€38"],["Render EU","€42","€12","€54"],["Fly.io (fra + ams)","€49","€12","€61"]]}}}\n' +
        '{"op":"add","path":"/elements/acts","value":{"type":"Actions","children":["b1","b2"]}}\n' +
        '{"op":"add","path":"/elements/b1","value":{"type":"ReplyButton","props":{"label":"Go with Hetzner + Bunny","prompt":"Lock in Hetzner + Bunny CDN and draft the deployment checklist"}}}\n' +
        '{"op":"add","path":"/elements/b2","value":{"type":"ReplyButton","props":{"label":"Check failover plan","prompt":"What happens if Falkenstein goes down? Give me a simple failover plan"}}}\n' +
        "```",
      createdAt: now - 2 * HOUR,
      saved: true,
      unread: false,
    },
    {
      id: "willow-1",
      conversationId: "conv-willow",
      tab: "done",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Compare the best hosting options for our next product experiment",
      fallbackTitle: "Hosting comparison",
      body:
        "### Hosting comparison\n\n" +
        "Three practical options for the first 10k users:\n\n" +
        "- **Hetzner Cloud (Falkenstein / Helsinki):** ~€24/mo for 4 vCPU + 8 GB RAM, predictable egress, EU data stays in-region.\n" +
        "- **Fly.io (fra + iad):** ~€61/mo for two regions with fast cold deploys and built-in Anycast routing.\n" +
        "- **Render:** ~€48/mo managed setup, slowest EU cold-start among the three.\n\n" +
        "**Initial recommendation:** Start with Hetzner + a lightweight CDN unless multi-region writes are required on day one.",
      createdAt: now - 3 * HOUR,
      saved: false,
      unread: false,
    },
    // @cedar's standalone Done card
    {
      id: "cedar-1",
      conversationId: "conv-cedar",
      tab: "done",
      agentName: "cedar",
      projectName: "Loop Core",
      model: "gpt-5.4",
      prompt: "Review PR #449 before merge",
      fallbackTitle: "Review PR #449 before merge",
      body:
        "No P1 or security findings in PR #449.\n\n" +
        "- Checked owner isolation and draft preservation across reloads\n" +
        "- Verified `done-stack.ts` stays pure with zero server imports\n" +
        "- Safe to merge once CI finishes green.",
      createdAt: now - 42 * MINUTE,
      saved: false,
      unread: true,
    },
    // Working tab (messages only — zero tool traces!)
    {
      id: "iris-1",
      conversationId: "conv-iris",
      tab: "working",
      agentName: "iris",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Benchmark spring physics and haptic cadence on iPhone 16 Pro",
      fallbackTitle: "Benchmark spring physics and haptic cadence",
      body: "Measuring frame stability at 120Hz while interpolating peeking card scale and backdrop blur intensity. Initial results show zero dropped frames on the native UI thread.",
      createdAt: now - 2 * MINUTE,
      saved: false,
      unread: false,
      statusLabel: "Working",
    },
    // Queued tab
    {
      id: "maple-1",
      conversationId: "conv-maple",
      tab: "queued",
      agentName: "maple",
      projectName: "Loop Core",
      model: "gpt-5.4",
      prompt: "Draft native iOS device pairing handshake for companion server",
      fallbackTitle: "Draft native iOS device pairing handshake",
      body: "Queued behind the current mobile gesture spike. Will design a scoped Keychain-backed device credential flow that preserves Loop's single-use QR pairing.",
      createdAt: now - 14 * MINUTE,
      saved: false,
      unread: false,
      statusLabel: "Queued",
    },
    // Replies tab
    {
      id: "fern-1",
      conversationId: "conv-fern",
      tab: "replies",
      agentName: "fern",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Should swipe-left on a Feed card toggle Save or open Remind?",
      fallbackTitle: "Feed card swipe-left action",
      body:
        "I mocked both options for single-handed thumb use:\n\n" +
        "- **Swipe right → Mark Done / Read** (highest-frequency triage action)\n" +
        "- **Swipe left → Toggle Save** (instant bookmark without opening a second sheet)\n\n" +
        "Want to keep Save on swipe-left, or swap it to Remind?",
      createdAt: now - 18 * MINUTE,
      saved: false,
      unread: true,
      statusLabel: "Needs reply",
    },
  ];
}

export function buildSimulatedReply(
  conversationId: string,
  agentName: string,
  projectName: string,
  model: string,
  prompt: string,
): NativeResultCard {
  const lower = prompt.toLowerCase();
  let body: string;

  if (lower.includes("failover") || lower.includes("falkenstein")) {
    body =
      "### Falkenstein failover plan\n\n" +
      "Keep recovery under 5 minutes without active-active complexity:\n\n" +
      "1. **Litestream / hourly SQLite snapshots** shipped to a second EU region (Helsinki).\n" +
      "2. **Warm standby VM** (~€7/mo) ready to hydrate and cut DNS via Bunny / Cloudflare.\n" +
      "3. **Health probe alert** pushed directly to Loop on your phone before users notice.";
  } else if (lower.includes("checklist") || lower.includes("hetzner")) {
    body =
      "### Hetzner + Bunny CDN launch checklist\n\n" +
      "- Provision 4 vCPU / 8 GB node in **Falkenstein (fsn1)** with automatic firewall rules\n" +
      "- Point static & published artifacts through **Bunny CDN EU zone** (2 TB ≈ €14/mo)\n" +
      "- Enable encrypted off-box SQLite backups every 6 hours\n" +
      "- Smoke-test cold restart and verify p95 latency stays under 45ms in Europe";
  } else {
    body =
      "### Follow-up ready\n\n" +
      `Captured your follow-up cleanly as a new discrete card in **@${agentName}**'s stack.\n\n` +
      "- **Zero chat scroll:** Earlier results remain tucked to the right in this carousel\n" +
      "- **Searchable immediately:** Tap `🔍` above to jump across every card in the thread\n" +
      "- **Native haptics:** Swipe left/right to feel the detent lock between cards";
  }

  return {
    id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    tab: "done",
    agentName,
    projectName,
    model,
    prompt,
    fallbackTitle: prompt,
    body,
    createdAt: Date.now(),
    saved: false,
    unread: true,
  };
}

export function relativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
