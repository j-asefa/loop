import { useEffect, useState } from "react";
import {
  UserRound,
  Newspaper,
  Search,
  Folder,
  GitPullRequest,
} from "lucide-react";
import { feedCategories, type FeedView } from "../../shared/feed-categories";
import { routeSourceId, sourceUrl } from "../sourceRouting";
import { initialShare } from "../workspace-drafts";

export const tabs = [
  { id: "feed", label: "Feed", icon: Newspaper },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Your profile", icon: UserRound },
];

export function readAppNavigation(url = new URL(location.href)) {
  const q = url.searchParams;
  const page = q.get("page") || "";
  const filter = q.get("filter");
  return {
    tab: q.has("social")
      ? "profile"
      : tabs.some((t) => t.id === page)
        ? page
        : q.has("folder")
          ? "profile"
          : "feed",
    feedFilter: feedCategories.some((f) => f.id === filter)
      ? (filter as FeedView)
      : ("done" as FeedView),
    sheet: q.has("memory")
      ? "memory"
      : q.has("tools")
        ? "mcp"
        : q.has("share") || url.pathname === "/share"
          ? "share"
          : q.has("connect")
            ? "connections"
            : "",
    returnTo: q.has("connect") ? "create" : "",
    folder: q.get("folder") || "",
    folderChoice: q.get("folder") ?? undefined,
    conversation: q.get("conversation"),
    messageId: q.get("message"),
    conversationSource: routeSourceId(url.search),
    teamSelection: (q.get("teams") || "").split(",").filter(Boolean),
    project: q.get("projectView") || "",
    pull: q.get("pull") || "",
    agentId: q.get("agent"),
    compose: q.has("compose"),
    artifactId: q.get("artifact"),
    later: q.get("later"),
    laterItem: q.get("laterItem") || undefined,
    projectFilter: q.get("project") || "",
    shareRequested: q.has("share") || url.pathname === "/share",
    sharedDraft: initialShare(url),
  };
}

export type AppNavigationInitial = ReturnType<typeof readAppNavigation>;

export function useAppNavigation(seed?: AppNavigationInitial) {
  const [initial] = useState(() => seed ?? readAppNavigation());
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("connect")) return;
    url.searchParams.delete("connect");
    history.replaceState(
      history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, []);
  const [tab, setTab] = useState(initial.tab);
  const [feedFilter, setFeedFilter] = useState(initial.feedFilter);
  const [sheet, setSheet] = useState(initial.sheet);
  const [returnTo, setReturnTo] = useState(initial.returnTo);
  const [folder, setFolder] = useState(initial.folder);
  const [conversation, updateConversation] = useState(initial.conversation);
  const [messageId, setMessageId] = useState(initial.messageId);
  const [conversationSource, setConversationSource] = useState(
    initial.conversationSource,
  );
  const [teamSelection, setTeamSelection] = useState(initial.teamSelection);
  const [projectFilter, setProjectFilter] = useState(initial.projectFilter);
  const [project, setProject] = useState(initial.project);
  const [pull, setPull] = useState(initial.pull);
  return {
    initial,
    tab,
    setTab,
    feedFilter,
    setFeedFilter,
    sheet,
    setSheet,
    returnTo,
    setReturnTo,
    folder,
    setFolder,
    conversation,
    updateConversation,
    messageId,
    setMessageId,
    conversationSource,
    setConversationSource,
    teamSelection,
    setTeamSelection,
    project,
    setProject,
    projectFilter,
    setProjectFilter,
    pull,
    setPull,
  };
}

export function replaceConversationLocation(
  source: string,
  conversation: string | null,
  message?: string,
) {
  const target = new URL(
    sourceUrl(source, {
      conversation: conversation || undefined,
      message: conversation ? message : undefined,
    }),
    location.origin,
  );
  const url = new URL(location.href);
  // Keep the surrounding page/filter URL while replacing the thread target.
  for (const name of ["conversation", "source", "message"]) {
    const value = target.searchParams.get(name);
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  history.replaceState(history.state, "", url.pathname + url.search);
}
