export type PairedSession = {
  origin: string;
  cookie: string;
  csrf: string;
  deviceId?: string;
  deviceName: string;
  pairedAt: number;
};

export type ApiAgent = {
  id: string;
  name: string;
  provider: string;
  connection_id: string | null;
  model: string;
  effort?: string | null;
  instructions: string;
  folder_id?: string | null;
  retired_at?: number | null;
};

/** A harness or API account. `models` and `metadata` are JSON text. */
export type ApiConnection = {
  id: string;
  provider: string;
  label: string;
  status: string;
  models: string;
  metadata: string;
};

export type ApiFolder = {
  id: string;
  name: string;
  parent_id: string | null;
  kind: "folder" | "project";
  path?: string | null;
  is_workspace?: boolean | number;
};

export type ApiTeam = {
  id: string;
  name: string;
  manager_id: string;
  members: string[];
  folder_id?: string | null;
};

export type ApiBootstrap = {
  agents: ApiAgent[];
  connections?: ApiConnection[];
  folders: ApiFolder[];
  teams: ApiTeam[];
  environmentName: string;
  preview?: {
    name: string;
    mode: "design" | "working";
  };
};

export type ApiFeedMessage = {
  id: string;
  role: string;
  preview?: string;
  content?: string;
  content_truncated?: boolean;
  created_at: number;
  saved?: boolean;
};

export type ApiQueuedRunSummary = {
  id: string;
  input: string;
  created_at: number;
  queue_position: number | null;
  can_edit?: boolean;
  can_move_up: boolean;
  can_move_down: boolean;
};

export type ApiFeedRun = {
  id: string;
  state: string;
  input?: string;
  connection_id?: string | null;
  model?: string | null;
  resolved_model?: string | null;
  error?: string | null;
  created_at?: number;
  updated_at?: number;
  queue_position?: number | null;
  can_move_up?: boolean;
  can_move_down?: boolean;
};

export type ApiFeedItem = {
  conversation_id: string;
  title: string;
  agent_id: string | null;
  agent_name: string | null;
  project_id?: string | null;
  project_name?: string | null;
  done_card_key?: string;
  reply_card_key?: string;
  read_at?: number | null;
  unread_version?: number;
  last_activity_at: number;
  last_message: ApiFeedMessage | null;
  run: ApiFeedRun | null;
  queued_runs?: ApiQueuedRunSummary[];
  live_preview?: string | null;
  pending_approvals: number;
  reply?: {
    message_id?: string;
    content?: string;
    read_at?: number | null;
  };
  next_action?: {
    kind: "approve" | "answer" | "result";
    message_id: string | null;
    run_id: string;
    ref?: string;
  } | null;
  card?: {
    type: string;
    display?: {
      last_message?: {
        id?: string;
        content?: string;
        preview?: string;
      } | null;
    };
  } | null;
};

export type ApiFeedSummary = {
  needs: number;
  working: number;
  queued: number;
  later_due: number;
  replies_unread?: number;
  done_unread?: number;
  social_unread?: number;
  scheduled_failed?: number;
  scheduled_pending?: number;
};

export type ApiFeedPage = {
  items: ApiFeedItem[];
  next: string | null;
  summary: ApiFeedSummary;
};

export type ApiDoneCardEntry = {
  card: {
    type: "done";
    id: string;
    content: string;
    created_at: number;
    saved: boolean;
    display: ApiFeedItem;
  };
};

export type ApiDoneCardPage = {
  revision: string;
  items: ApiDoneCardEntry[];
  next: string | null;
};

export type ApiMessage = {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: string;
  content: string;
  created_at: number;
  run_state?: string | null;
  run_error?: string | null;
};

export type ApiConversationPage = {
  conversation: {
    id: string;
    agent_id: string | null;
    title: string;
    project_id: string | null;
  };
  working: boolean;
  messages: ApiMessage[];
  next: string | null;
  saved: string[];
  steerable_run_id: string | null;
};

export type ApiApproval = {
  id: string;
  run_id: string;
  conversation_id: string;
  agent_id: string;
  agent_name?: string | null;
  tool_name: string;
  summary?: string | null;
  arguments?: string | null;
  state: string;
  created_at: number;
};

export type ApiNativeDecision = {
  id: string;
  run_id: string;
  conversation_id: string;
  agent_id?: string | null;
  kind?: string;
  title?: string;
  prompt?: string;
  question?: string;
  options?: Array<{ id?: string; label: string; description?: string }>;
  state: string;
  created_at: number;
};

export type ApiSnippet = {
  id: string;
  title: string;
  content: string;
};

export type ApiProjectSummary = {
  id: string;
  name: string;
  conversation_count?: number;
  active_count?: number;
  unread_count?: number;
  done_count?: number;
  last_activity_at?: number | null;
};

export type ApiSearchItem = {
  id: string;
  kind: string;
  title: string;
  agent_id: string | null;
  conversation_id: string | null;
  folder_id: string | null;
  created_at: number;
  updated_at: number;
  name?: string;
  snippet?:
    | string
    | { text?: string; segments?: Array<{ text: string; match?: boolean }> };
  message_id: string | null;
};

export type ApiSearchResponse = {
  mode: string;
  items: ApiSearchItem[];
  next: number | null;
};

export type ApiPullItem = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state?: string;
  draft?: boolean;
  author?: string | null;
  url?: string;
  updated_at?: number | string;
  checks_state?: string | null;
  review_decision?: string | null;
  conversation_id?: string | null;
};

export type ApiSavedEntry = {
  kind: "message" | "result";
  key: string;
  saved_at: number;
  label: string | null;
  message?: {
    message_id: string;
    conversation_id: string;
    conversation_title: string;
    content: string;
    preview: string;
    agent_name: string | null;
    project_name: string | null;
    created_at: number;
  };
  result?: {
    id: string;
    title: string;
    content?: string;
    conversation_id?: string | null;
    created_at: number;
  };
};

export type ApiLaterItem = {
  id: string;
  kind: string;
  target_id: string;
  title?: string | null;
  agent_name?: string | null;
  condition: string;
  due_at: number | null;
  surfaced_at: number | null;
  conversation_id?: string | null;
  created_at: number;
};

export type ApiScheduledSend = {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  conversation_id: string | null;
  input: string;
  send_at: number;
  state: string;
  error?: string | null;
};

export type ApiPersonalPrompt = {
  id: string;
  conversation_id: string;
  conversation_title?: string;
  agent_name?: string | null;
  project_name?: string | null;
  content: string;
  created_at: number;
};

export type ApiPersonalFile = {
  id: string;
  title: string;
  metadata?: string;
  filename?: string | null;
  mime?: string | null;
  size?: number | null;
  agent_name?: string | null;
  project_name?: string | null;
  conversation_id?: string | null;
  created_at: number;
};

export type ApiArtifactDetail = {
  id: string;
  title: string;
  kind?: string;
  role?: string;
  content?: string;
  metadata?: string;
  conversation_id?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  created_at?: number;
};

export type ApiRunFile = {
  id: string;
  title: string;
  metadata: string;
};

export type ApiSocialStory = {
  id: string;
  title: string;
  feed_title?: string | null;
  summary?: string | null;
  url?: string | null;
  published_at?: number | null;
  read?: boolean;
};

export type ApiPersonalProfile = {
  name?: string | null;
  handle?: string | null;
  bio?: string | null;
  prompt_count?: number;
  agent_count?: number;
  project_count?: number;
};
