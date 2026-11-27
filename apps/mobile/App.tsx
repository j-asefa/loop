import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  Folder,
  GitPullRequest,
  Inbox,
  Search,
  UserRound,
} from "lucide-react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  isUncertainOutcomeError,
  LoopApiError,
  LoopClient,
} from "./src/api/client";
import type { PendingAgentCreate } from "./src/drafts-codec";
import {
  guessMimeFromName,
  type LoopFileTarget,
  type PublishedFileItem,
} from "./src/api/files";
import {
  clearPairedSession,
  loadPairedSession,
  savePairedSession,
} from "./src/api/pairing";
import { isSamePairedDevice } from "./src/api/pairing-url";
import {
  applyLiveStreamBatch,
  buildAgentQueuedRuns,
  canPauseRun,
  clearRunFromLiveStreams,
  LoopEventSocket,
  pruneLiveStreams,
  type LiveStreamEvent,
  type LiveStreamOverlay,
  type SocketStatus,
} from "./src/api/socket";
import {
  ActionKeyStore,
  runSaveToggle,
  WorkspaceLoadCoordinator,
} from "./src/workspace-runtime";
import type {
  ApiAgent,
  ApiApproval,
  ApiFeedItem,
  ApiFeedSummary,
  ApiFolder,
  ApiNativeDecision,
  ApiConnection,
  ApiSnippet,
  PairedSession,
} from "./src/api/types";
import {
  AgentProfileSheet,
  type AgentRunSummary,
} from "./src/components/AgentProfileSheet";
import {
  ComposeSheet,
  type ComposeSubmit,
  type ComposeTarget,
} from "./src/components/ComposeSheet";
import { FeedScreen } from "./src/components/FeedScreen";
import { FilePreviewModal } from "./src/components/FilePreviewModal";
import { PairingModal } from "./src/components/PairingModal";
import { ProfileScreen } from "./src/components/ProfileScreen";
import { ProjectsScreen } from "./src/components/ProjectsScreen";
import { PullRequestsScreen } from "./src/components/PullRequestsScreen";
import { RemindSheet, type RemindChoice } from "./src/components/RemindSheet";
import { SearchScreen } from "./src/components/SearchScreen";
import {
  ShareInboxSheet,
  useIncomingShareIntake,
} from "./src/components/ShareInboxSheet";
import { SpotlightCarousel } from "./src/components/SpotlightCarousel";
import { ThreadSheet } from "./src/components/ThreadSheet";
import { clearWorkspaceDrafts } from "./src/drafts";
import { draftWorkspaceBucket } from "./src/drafts-codec";
import {
  clearWorkspaceNotificationPrefs,
  configureNotificationsHandler,
  DEFAULT_NOTIFICATION_PREFS,
  deliverLocalNotifications,
  detectNotificationEvents,
  loadNotificationPrefs,
  parseNotificationTapTarget,
  saveNotificationPrefs,
  subscribeNotificationTaps,
  type NotificationPrefs,
  type NotificationSnapshot,
} from "./src/notifications";
import {
  clearWorkspaceCache,
  loadWorkspaceCache,
  saveWorkspaceCache,
} from "./src/offline-cache";
import { sortSnippetsByUsage } from "./src/snippet-usage-codec";
import { formatScheduledTime } from "./src/schedule-utils";
import {
  buildSimulatedReply,
  createInitialCards,
  feedItemToNativeCard,
  getCardDismissTargets,
  mergeCarouselCards,
  mergeUnifiedFeedCards,
  type NativeResultCard,
} from "./src/fixtures";
import { haptics } from "./src/haptics";
import { DARK_THEME, LIGHT_THEME } from "./src/theme";

function clearPairedWorkspaceData(origin: string, requireFileRemoval = false) {
  clearWorkspaceDrafts(origin, { requireFileRemoval });
  clearWorkspaceCache(origin);
  clearWorkspaceNotificationPrefs(origin);
}

type AppTab = "feed" | "projects" | "pulls" | "search" | "profile";

const DEMO_AGENTS: ApiAgent[] = [
  {
    id: "agent-willow",
    name: "willow",
    provider: "anthropic",
    connection_id: null,
    model: "claude-sonnet-4",
    instructions: "",
  },
  {
    id: "agent-cedar",
    name: "cedar",
    provider: "openai",
    connection_id: null,
    model: "gpt-5.4",
    instructions: "",
  },
  {
    id: "agent-iris",
    name: "iris",
    provider: "anthropic",
    connection_id: null,
    model: "claude-sonnet-4",
    instructions: "",
  },
];

type ToastState = {
  text: string;
  undo?: () => void;
};

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <LoopShell />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function LoopShell() {
  const insets = useSafeAreaInsets();
  const [darkMode, setDarkMode] = useState(false);
  const theme = darkMode ? DARK_THEME : LIGHT_THEME;
  const tabBarBottom = Math.max(insets.bottom, 12);

  // Companion session (Keychain-backed)
  const [session, setSession] = useState<PairedSession | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("offline");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingInitialUrl, setPairingInitialUrl] = useState("");

  // Navigation
  const [appTab, setAppTab] = useState<AppTab>("feed");
  const feedScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lastFeedTapRef = useRef(0);

  // Workspace state (live or demo fallback)
  const [demoCards, setDemoCards] = useState<NativeResultCard[]>(() =>
    createInitialCards(),
  );
  const [liveCards, setLiveCards] = useState<NativeResultCard[]>([]);
  const [olderFeedCards, setOlderFeedCards] = useState<NativeResultCard[]>([]);
  // Keep cursor value and endpoint source atomic so a refresh can never mix a `feed`
  // cursor with the `cards` endpoint (or vice versa).
  const [feedCursor, setFeedCursor] = useState<{
    source: "cards" | "feed";
    before: string;
  } | null>(null);
  const [loadingMoreFeed, setLoadingMoreFeed] = useState(false);
  const hasLoadedOlderFeedRef = useRef(false);
  const feedPageEpochRef = useRef(0);
  const [summary, setSummary] = useState<ApiFeedSummary | null>(null);
  const [agents, setAgents] = useState<ApiAgent[]>(DEMO_AGENTS);
  const [folders, setFolders] = useState<ApiFolder[]>([]);
  const [snippets, setSnippets] = useState<ApiSnippet[]>([]);
  const sortedSnippets = useMemo(
    () => sortSnippetsByUsage(snippets),
    [snippets],
  );
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [approvals, setApprovals] = useState<ApiApproval[]>([]);
  const [decisions, setDecisions] = useState<ApiNativeDecision[]>([]);
  const [activeRuns, setActiveRuns] = useState<AgentRunSummary[]>([]);
  const [queuedFeedItems, setQueuedFeedItems] = useState<ApiFeedItem[]>([]);
  const [liveStreams, setLiveStreams] = useState<
    Map<string, LiveStreamOverlay>
  >(() => new Map());
  const liveStreamsRef = useRef<Map<string, LiveStreamOverlay>>(new Map());
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeRunsRef = useRef<AgentRunSummary[]>([]);
  activeRunsRef.current = activeRuns;
  const [environmentName, setEnvironmentName] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [showingCachedSnapshot, setShowingCachedSnapshot] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const hasLiveLoadRef = useRef(false);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(
    () => ({ ...DEFAULT_NOTIFICATION_PREFS }),
  );
  const [notificationPrefsLoaded, setNotificationPrefsLoaded] = useState(false);
  const notificationPrefsLoadedRef = useRef(false);
  notificationPrefsLoadedRef.current = notificationPrefsLoaded;
  const notificationPrefsRef = useRef<NotificationPrefs>(notificationPrefs);
  notificationPrefsRef.current = notificationPrefs;
  const notificationSnapshotRef = useRef<NotificationSnapshot | null>(null);
  const pendingNotificationTapRef = useRef<unknown>(null);
  // Bumped after each workspace load so an open thread refreshes in place.
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const { incomingShare, dismissIncomingShare } = useIncomingShareIntake();

  // Overlays & modals
  const [openConversationId, setOpenConversationId] = useState<string | null>(
    null,
  );
  const [carouselOverrideCards, setCarouselOverrideCards] = useState<
    NativeResultCard[] | null
  >(null);
  const [profileAgent, setProfileAgent] = useState<ApiAgent | null>(null);
  const [threadOverlay, setThreadOverlay] = useState<{
    conversationId: string;
    title: string;
    agentName: string;
    agentId?: string | null;
  } | null>(null);
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(
    null,
  );
  const composeOpen = composeTarget !== null;
  const [remindCard, setRemindCard] = useState<NativeResultCard | null>(null);
  const [previewFile, setPreviewFile] = useState<PublishedFileItem | null>(
    null,
  );

  // Toast with optional Undo
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, undo?: () => void) => {
    setToast({ text, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), undo ? 4200 : 2400);
  }, []);

  // Load saved Keychain session on startup & listen for deep-linked pairing URLs
  useEffect(() => {
    configureNotificationsHandler();
    void loadPairedSession().then((saved) => {
      if (saved) setSession(saved);
    });
    const inspectUrl = (incoming: string | null | undefined) => {
      if (!incoming) return;
      if (incoming.includes("#pair=") || incoming.includes("#fleet=")) {
        setPairingInitialUrl(incoming);
        setPairingOpen(true);
      }
    };
    void Linking.getInitialURL()
      .then(inspectUrl)
      .catch(() => {});
    const sub = Linking.addEventListener("url", (event) =>
      inspectUrl(event.url),
    );
    const unsubNotifTap = subscribeNotificationTaps((data) => {
      const origin = activeSessionRef.current?.origin;
      if (!origin) {
        // Hold cold-start notification taps until Keychain session finishes loading
        pendingNotificationTapRef.current = data;
        return;
      }
      const target = parseNotificationTapTarget(
        data,
        draftWorkspaceBucket(origin),
      );
      if (!target) return;
      setOpenConversationId(null);
      setCarouselOverrideCards(null);
      setProfileAgent(null);
      setThreadOverlay({
        conversationId: target.conversationId,
        title: target.title,
        agentName: target.agentName,
      });
    });
    return () => {
      sub.remove();
      unsubNotifTap();
    };
  }, []);

  const activeSessionRef = useRef<PairedSession | null>(null);
  activeSessionRef.current = session;

  const handleUnauthorizedForSession = useCallback(
    (expiredSession: PairedSession) => {
      // Ignore stale 401s from a previous workspace after switching workspaces
      if (activeSessionRef.current !== expiredSession) return;
      // Invalidate any in-flight workspace loads BEFORE deleting local files so a
      // sibling fetchAll cannot recreate cache or fire notifications after expiry.
      workspaceGenRef.current = loadCoordRef.current.reset();
      clearPairedWorkspaceData(expiredSession.origin);
      void clearPairedSession();
      setComposeTarget(null);
      setSession(null);
      setSocketStatus("offline");
      setPairingOpen(true);
      showToast("Session expired — pair this phone again");
    },
    [showToast],
  );

  const client = useMemo(
    () =>
      session
        ? new LoopClient(session, () => handleUnauthorizedForSession(session))
        : null,
    [session, handleUnauthorizedForSession],
  );

  const workspaceGenRef = useRef(0);
  const loadCoordRef = useRef(new WorkspaceLoadCoordinator());
  // Durable per-target idempotency/command keys so retries after uncertain timeouts reuse the same key
  const actionKeysRef = useRef(new ActionKeyStore());
  const inFlightRunActionsRef = useRef<Set<string>>(new Set());
  // Maps `runId -> timedOutAt` for reorders whose outcome is uncertain; released only by a
  // queue refresh started after `timedOutAt` (or after 15s fallback so offline never wedges).
  const uncertainReordersRef = useRef<Map<string, number>>(new Map());

  const loadWorkspace = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!client) return;
      const gen = loadCoordRef.current.currentGeneration;
      await loadCoordRef.current.run(options ?? { silent: true }, {
        setRefreshing,
        refreshSession: () => client.refreshSession(),
        fetchAll: async () => {
          const fetchStartedAt = Date.now();
          const [
            boot,
            feedPage,
            doneCardPage,
            replyPage,
            queuedPage,
            workingPage,
            appList,
            decList,
            snipList,
            runList,
          ] = await Promise.all([
            client.bootstrap(),
            client.feed("done"),
            client.doneCardsPage().catch(() => null),
            client.feed("replies").catch(() => null),
            client.feed("queued").catch(() => null),
            client.feed("working").catch(() => null),
            client.approvals().catch(() => null),
            client.nativeDecisions().catch(() => null),
            client.snippets().catch(() => [] as ApiSnippet[]),
            client.runs(true).catch(() => null),
          ]);
          // Drop stale results if workspace switched or signed out mid-flight
          if (gen !== loadCoordRef.current.currentGeneration) return;
          setAgents(boot.agents);
          setConnections(boot.connections ?? []);
          setFolders(boot.folders);
          setEnvironmentName(boot.environmentName || "");
          setSummary(feedPage.summary);

          const useCardsSource = Boolean(
            doneCardPage && doneCardPage.items.length > 0,
          );
          const doneSource = useCardsSource
            ? doneCardPage!.items
            : feedPage.items;
          const nextTopCards = mergeUnifiedFeedCards(
            doneSource,
            replyPage?.items ?? [],
          );
          const nextPageCursor = useCardsSource
            ? doneCardPage?.next
              ? { source: "cards" as const, before: doneCardPage.next }
              : null
            : feedPage.next
              ? { source: "feed" as const, before: feedPage.next }
              : null;
          if (options?.silent === false) {
            feedPageEpochRef.current += 1;
            hasLoadedOlderFeedRef.current = false;
            setOlderFeedCards([]);
            setLoadingMoreFeed(false);
            setFeedCursor(nextPageCursor);
          } else if (!hasLoadedOlderFeedRef.current) {
            setFeedCursor(nextPageCursor);
          }
          setLiveCards(nextTopCards);
          if (queuedPage || workingPage) {
            setQueuedFeedItems([
              ...(queuedPage?.items ?? []),
              ...(workingPage?.items ?? []),
            ]);
            // Release uncertain-reorder locks only for timeouts that occurred BEFORE this
            // refresh started — never releasing an actively in-flight reorder request.
            for (const [id, timedOutAt] of Array.from(
              uncertainReordersRef.current.entries(),
            )) {
              if (fetchStartedAt > timedOutAt) {
                uncertainReordersRef.current.delete(id);
              }
            }
          }
          if (appList !== null) setApprovals(appList);
          if (decList !== null) setDecisions(decList);
          setSnippets(snipList);
          if (runList !== null) {
            setActiveRuns(runList);
            actionKeysRef.current.reconcileRunActions(runList);
            if (
              pruneLiveStreams(liveStreamsRef.current, runList, fetchStartedAt)
            ) {
              setLiveStreams(new Map(liveStreamsRef.current));
            }
          }
          setWorkspaceVersion((v) => v + 1);
          hasLiveLoadRef.current = true;
          setShowingCachedSnapshot(false);
          setCachedAt(null);
          // Bind cache and notifications strictly to the client that performed this fetch
          const fetchOrigin = client.origin;
          saveWorkspaceCache(fetchOrigin, {
            environmentName: boot.environmentName || "",
            cards: nextTopCards,
            agents: boot.agents,
            folders: boot.folders,
            summary: feedPage.summary,
          });
          const { nextSnapshot, events } = detectNotificationEvents(
            notificationSnapshotRef.current,
            {
              approvals: appList,
              decisions: decList,
              cards: nextTopCards,
              repliesLoaded: replyPage !== null,
            },
            notificationPrefsRef.current,
          );
          notificationSnapshotRef.current = nextSnapshot;
          if (events.length > 0 && notificationPrefsLoadedRef.current) {
            void deliverLocalNotifications(
              fetchOrigin,
              events,
              () => gen === loadCoordRef.current.currentGeneration,
            );
          }
        },
        onError: (err) => {
          if (err instanceof Error && !err.message.includes("401")) {
            showToast(err.message);
          }
        },
      });
    },
    [client, showToast],
  );

  const loadWorkspaceRef = useRef(loadWorkspace);
  loadWorkspaceRef.current = loadWorkspace;

  const scheduleSilentRefresh = useCallback((delayMs: number, gen: number) => {
    setTimeout(() => {
      if (gen === workspaceGenRef.current) {
        void loadWorkspaceRef.current({ silent: true });
      }
    }, delayMs);
  }, []);

  // Reset workspace state cleanly on every client switch (including A -> B) and fetch silently
  useEffect(() => {
    workspaceGenRef.current = loadCoordRef.current.reset();
    actionKeysRef.current.clear();
    inFlightRunActionsRef.current.clear();
    uncertainReordersRef.current.clear();
    // Clear stale Undo toasts from the previous workspace while preserving status toasts (expiry/pair/sign-out)
    setToast((prev) => (prev?.undo ? null : prev));
    setRefreshing(false);
    setLiveCards([]);
    setOlderFeedCards([]);
    setFeedCursor(null);
    setLoadingMoreFeed(false);
    hasLoadedOlderFeedRef.current = false;
    feedPageEpochRef.current += 1;
    setFolders([]);
    setApprovals([]);
    setDecisions([]);
    setSnippets([]);
    setConnections([]);
    setActiveRuns([]);
    setQueuedFeedItems([]);
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    liveStreamsRef.current = new Map();
    setLiveStreams(new Map());
    setSummary(null);
    setEnvironmentName("");
    setShowingCachedSnapshot(false);
    setCachedAt(null);
    hasLiveLoadRef.current = false;
    notificationSnapshotRef.current = null;
    setOpenConversationId(null);
    setCarouselOverrideCards(null);
    setProfileAgent(null);
    setThreadOverlay(null);
    setComposeTarget(null);
    setRemindCard(null);
    setPreviewFile(null);
    if (!client) {
      setAgents(DEMO_AGENTS);
      setNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS });
      setNotificationPrefsLoaded(true);
      setSocketStatus("offline");
      return;
    }
    setAgents([]);
    setNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS });
    setNotificationPrefsLoaded(false);
    const gen = workspaceGenRef.current;
    const origin = client.origin;
    // Drain any cold-start notification tap AFTER resetting overlays so this
    // commit never wipes out the deep-linked thread.
    if (pendingNotificationTapRef.current) {
      const pendingTap = pendingNotificationTapRef.current;
      pendingNotificationTapRef.current = null;
      const target = parseNotificationTapTarget(
        pendingTap,
        draftWorkspaceBucket(origin),
      );
      if (target) {
        setThreadOverlay({
          conversationId: target.conversationId,
          title: target.title,
          agentName: target.agentName,
        });
      }
    }
    void loadNotificationPrefs(origin).then((prefs) => {
      if (gen === workspaceGenRef.current) {
        setNotificationPrefs(prefs);
        setNotificationPrefsLoaded(true);
      }
    });
    void loadWorkspaceCache(origin).then((snap) => {
      // Hydrate instant cold-start cache only if still on the same workspace
      // and no live server load has completed yet.
      if (!snap || gen !== workspaceGenRef.current || hasLiveLoadRef.current) {
        return;
      }
      setLiveCards(snap.cards);
      setAgents(snap.agents);
      setFolders(snap.folders);
      setSummary(snap.summary);
      setEnvironmentName(snap.environmentName);
      setShowingCachedSnapshot(true);
      setCachedAt(snap.cachedAt);
    });
    void loadWorkspace({ silent: true });
  }, [client, loadWorkspace]);

  const handleStreamEvents = useCallback((events: LiveStreamEvent[]) => {
    const changed = applyLiveStreamBatch(
      liveStreamsRef.current,
      events,
      activeRunsRef.current,
    );
    if (changed && !streamFlushTimerRef.current) {
      streamFlushTimerRef.current = setTimeout(() => {
        streamFlushTimerRef.current = null;
        setLiveStreams(new Map(liveStreamsRef.current));
      }, 100);
    }
  }, []);

  // Live WebSocket updates when paired
  useEffect(() => {
    if (!session || !client) return;
    const sock = new LoopEventSocket(
      session,
      () => void loadWorkspaceRef.current({ silent: true }),
      setSocketStatus,
      handleStreamEvents,
    );
    sock.start();
    return () => {
      sock.stop();
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
    };
  }, [session, client, handleStreamEvents]);

  const handleLoadMoreFeed = useCallback(async () => {
    if (!client || !feedCursor || loadingMoreFeed) return;
    const gen = loadCoordRef.current.currentGeneration;
    const epoch = feedPageEpochRef.current;
    const { source, before } = feedCursor;
    setLoadingMoreFeed(true);
    try {
      const page =
        source === "cards"
          ? await client.doneCardsPage({ before })
          : await client.feed("done", { before });
      if (
        gen !== loadCoordRef.current.currentGeneration ||
        epoch !== feedPageEpochRef.current
      ) {
        return;
      }
      const mapped = mergeUnifiedFeedCards(page.items, []);
      hasLoadedOlderFeedRef.current = true;
      setOlderFeedCards((prev) => {
        const seenIds = new Set(prev.map((c) => c.id));
        const seenMsgIds = new Set(
          prev.map((c) => c.messageId).filter(Boolean),
        );
        const extra = mapped.filter(
          (c) =>
            !seenIds.has(c.id) &&
            (!c.messageId || !seenMsgIds.has(c.messageId)),
        );
        return extra.length > 0 ? [...prev, ...extra] : prev;
      });
      setFeedCursor(page.next ? { source, before: page.next } : null);
    } catch (err) {
      if (
        gen === loadCoordRef.current.currentGeneration &&
        epoch === feedPageEpochRef.current
      ) {
        showToast(
          err instanceof Error ? err.message : "Could not load older cards.",
        );
      }
    } finally {
      if (
        gen === loadCoordRef.current.currentGeneration &&
        epoch === feedPageEpochRef.current
      ) {
        setLoadingMoreFeed(false);
      }
    }
  }, [client, feedCursor, loadingMoreFeed, showToast]);

  const activeCards = useMemo(() => {
    if (!client) return demoCards;
    if (olderFeedCards.length === 0) return liveCards;
    const seenIds = new Set(liveCards.map((c) => c.id));
    const seenMsgIds = new Set(
      liveCards.map((c) => c.messageId).filter(Boolean),
    );
    const extra = olderFeedCards.filter(
      (c) =>
        !seenIds.has(c.id) && (!c.messageId || !seenMsgIds.has(c.messageId)),
    );
    return extra.length > 0 ? [...liveCards, ...extra] : liveCards;
  }, [client, demoCards, liveCards, olderFeedCards]);

  const effectiveActiveRuns = useMemo<AgentRunSummary[]>(() => {
    if (client) return activeRuns;
    return demoCards
      .filter((c) => (c.tab === "working" || c.tab === "queued") && c.agentId)
      .map((c) => ({
        id: c.id,
        agent_id: c.agentId!,
        conversation_id: c.conversationId,
        state: c.tab === "queued" ? "queued" : "running",
        input: c.prompt,
        created_at: c.createdAt,
      }));
  }, [client, activeRuns, demoCards]);

  const openCarouselCards = useMemo(() => {
    if (!openConversationId) return [];
    const overrides = (carouselOverrideCards ?? []).filter(
      (c) => c.conversationId === openConversationId,
    );
    const matching = activeCards.filter(
      (c) => c.conversationId === openConversationId,
    );
    return mergeCarouselCards(matching, overrides);
  }, [activeCards, carouselOverrideCards, openConversationId]);

  const isCarouselOpen = Boolean(
    openConversationId && openCarouselCards.length > 0,
  );

  // Never leave openConversationId dangling if its cards disappear (e.g. dismissed or filtered out)
  useEffect(() => {
    if (openConversationId && openCarouselCards.length === 0) {
      setOpenConversationId(null);
      setCarouselOverrideCards(null);
    }
  }, [openConversationId, openCarouselCards.length]);

  const handleMarkRead = useCallback(
    (card: NativeResultCard) => {
      const clearRead = (prev: NativeResultCard[]) =>
        prev.map((c) =>
          c.id === card.id
            ? { ...c, unread: false, doneUnread: false, replyUnread: false }
            : c,
        );
      if (client) {
        const markDone = Boolean(
          card.doneCardKey && (card.doneUnread ?? !card.replyCardKey),
        );
        const markReply = Boolean(
          card.replyCardKey &&
          card.messageId &&
          (card.replyUnread ?? !card.doneCardKey),
        );
        setLiveCards(clearRead);
        setOlderFeedCards(clearRead);
        setCarouselOverrideCards((prev) => (prev ? clearRead(prev) : prev));
        setSummary((prev) =>
          prev
            ? {
                ...prev,
                done_unread: markDone
                  ? Math.max(0, (prev.done_unread ?? 0) - 1)
                  : prev.done_unread,
                replies_unread: markReply
                  ? Math.max(0, (prev.replies_unread ?? 0) - 1)
                  : prev.replies_unread,
              }
            : prev,
        );
        if (markDone && card.doneCardKey) {
          void client
            .markDoneRead(
              card.conversationId,
              card.doneCardKey,
              card.unreadVersion,
            )
            .catch(() => {});
        }
        if (markReply && card.messageId) {
          void client
            .setReplyState(card.messageId, { read: true })
            .catch(() => {});
        }
        return;
      }
      setDemoCards(clearRead);
      setCarouselOverrideCards((prev) => (prev ? clearRead(prev) : prev));
    },
    [client],
  );

  const handleToggleSaved = useCallback(
    async (card: NativeResultCard) => {
      const nextSaved = !card.saved;
      const matchesCard = (c: NativeResultCard) =>
        c.id === card.id ||
        Boolean(card.messageId && c.messageId === card.messageId);
      const applySaved = (saved: boolean) => (prev: NativeResultCard[]) =>
        prev.map((c) => (matchesCard(c) ? { ...c, saved } : c));
      if (client) {
        if (!card.messageId) return;
        const msgId = card.messageId;
        const gen = workspaceGenRef.current;
        return runSaveToggle({
          nextSaved,
          generation: gen,
          getGeneration: () => workspaceGenRef.current,
          applyLocal: (saved) => {
            setLiveCards(applySaved(saved));
            setOlderFeedCards(applySaved(saved));
            setCarouselOverrideCards((prev) =>
              prev ? applySaved(saved)(prev) : prev,
            );
          },
          commit: () => client.setSaved(msgId, nextSaved),
          onSuccess: () =>
            showToast(nextSaved ? "Saved card" : "Removed from Saved"),
          onUncertain: () => {
            showToast("Save status uncertain — syncing…");
            scheduleSilentRefresh(500, gen);
          },
          onDefiniteError: (err) => {
            showToast(
              err instanceof Error ? err.message : "Could not update Saved.",
            );
          },
        });
      }
      setDemoCards(applySaved(nextSaved));
      setCarouselOverrideCards((prev) =>
        prev ? applySaved(nextSaved)(prev) : prev,
      );
      showToast(nextSaved ? "Saved card" : "Removed from Saved");
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleDismissCard = useCallback(
    (card: NativeResultCard) => {
      const removeCard = (prev: NativeResultCard[]) =>
        prev.filter((c) => c.id !== card.id);
      if (client) {
        const { doneKey, replyMessageId } = getCardDismissTargets(card);
        if (!doneKey && !replyMessageId) return;
        const gen = workspaceGenRef.current;
        setLiveCards(removeCard);
        setOlderFeedCards(removeCard);
        setCarouselOverrideCards((prev) => (prev ? removeCard(prev) : prev));
        if (doneKey) {
          void client
            .setDoneHidden(card.conversationId, doneKey, true)
            .catch(() => {});
        }
        if (replyMessageId) {
          void client
            .setReplyState(replyMessageId, { archived: true })
            .catch(() => {});
        }
        showToast(doneKey ? "Marked done" : "Archived reply", () => {
          if (gen !== workspaceGenRef.current) return;
          haptics.light();
          const restores: Promise<unknown>[] = [];
          if (doneKey) {
            restores.push(
              client.setDoneHidden(card.conversationId, doneKey, false),
            );
          }
          if (replyMessageId) {
            restores.push(
              client.setReplyState(replyMessageId, { archived: false }),
            );
          }
          void Promise.all(restores)
            .then(() => {
              if (gen !== workspaceGenRef.current) return;
              // Restore into olderFeedCards only after server confirms so paginated cards
              // reappear immediately without leaving a phantom card on failure.
              setOlderFeedCards((prev) =>
                prev.some((c) => c.id === card.id) ? prev : [card, ...prev],
              );
              void loadWorkspaceRef.current({ silent: true });
            })
            .catch(() => {
              if (gen === workspaceGenRef.current) {
                showToast("Could not undo — syncing…");
                void loadWorkspaceRef.current({ silent: true });
              }
            });
        });
        return;
      }
      setDemoCards(removeCard);
      setCarouselOverrideCards((prev) => (prev ? removeCard(prev) : prev));
      showToast(`Marked @${card.agentName} card done`, () => {
        haptics.light();
        setDemoCards((prev) => [card, ...prev]);
      });
    },
    [client, showToast],
  );

  const handlePickReminder = useCallback(
    async (choice: RemindChoice) => {
      const card = remindCard;
      setRemindCard(null);
      if (!card) return;
      if (client) {
        try {
          await client.createReminder({
            kind: card.messageId ? "message" : "conversation",
            targetId: card.messageId || card.conversationId,
            condition: choice.condition,
            ...(choice.dueAt ? { dueAt: choice.dueAt } : {}),
          });
          showToast(`Reminder set: ${choice.label}`);
        } catch (err) {
          showToast((err as Error).message || "Could not set reminder");
        }
      } else {
        showToast(`Reminder set: ${choice.label}`);
      }
    },
    [client, remindCard, showToast],
  );

  const handleCarouselReply = useCallback(
    async (
      card: NativeResultCard,
      prompt: string,
      attachmentIds?: string[],
      idempotencyKey?: string,
      queue?: boolean,
    ) => {
      if (client) {
        const gen = workspaceGenRef.current;
        const agentId =
          card.agentId ||
          agents.find((a) => a.name === card.agentName)?.id ||
          agents[0]?.id;
        if (!agentId) {
          throw new Error("No agent available to receive this reply.");
        }
        await client.submitRun({
          agentId,
          conversationId: card.conversationId,
          replyToMessageId: card.messageId,
          input: prompt,
          attachmentIds,
          idempotencyKey,
          queue,
        });
        if (gen !== workspaceGenRef.current) return;
        showToast(
          queue
            ? `Queued for @${card.agentName}`
            : attachmentIds?.length
              ? `Sent to @${card.agentName} with ${attachmentIds.length} ${attachmentIds.length === 1 ? "file" : "files"}`
              : `Sent to @${card.agentName}`,
        );
        scheduleSilentRefresh(0, gen);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      const nextCard = buildSimulatedReply(
        card.conversationId,
        card.agentName,
        card.projectName,
        card.model,
        prompt,
      );
      setDemoCards((prev) => [nextCard, ...prev]);
      haptics.success();
    },
    [client, agents, scheduleSilentRefresh, showToast],
  );

  const handleCarouselSchedule = useCallback(
    async (
      card: NativeResultCard,
      prompt: string,
      attachmentIds: string[],
      idempotencyKey: string,
      sendAt: number,
    ) => {
      if (!client) {
        throw new Error("Pair with a Loop workspace to schedule messages.");
      }
      const gen = workspaceGenRef.current;
      const agentId =
        card.agentId ||
        agents.find((a) => a.name === card.agentName)?.id ||
        agents[0]?.id;
      if (!agentId) {
        throw new Error("No agent available to receive this scheduled reply.");
      }
      await client.createScheduledSend({
        agentId,
        conversationId: card.conversationId,
        replyToMessageId: card.messageId,
        input: prompt,
        attachmentIds,
        idempotencyKey,
        sendAt,
      });
      if (gen === workspaceGenRef.current) {
        haptics.success();
        showToast(
          `Scheduled for @${card.agentName} · ${formatScheduledTime(sendAt)}`,
        );
        scheduleSilentRefresh(400, gen);
      }
    },
    [agents, client, scheduleSilentRefresh, showToast],
  );

  const handleComposeSchedule = useCallback(
    async (
      agent: ApiAgent,
      input: ComposeSubmit & { sendAt: number; folderId?: string | null },
    ) => {
      if (!client) {
        throw new Error("Pair with a Loop workspace to schedule messages.");
      }
      const gen = workspaceGenRef.current;
      await client.createScheduledSend({
        agentId: agent.id,
        folderId:
          input.folderId !== undefined
            ? input.folderId
            : (agent.folder_id ?? null),
        input: input.text,
        attachmentIds: input.attachmentIds ?? [],
        idempotencyKey: input.idempotencyKey,
        sendAt: input.sendAt,
      });
      if (gen === workspaceGenRef.current) {
        haptics.success();
        showToast(
          `Scheduled for @${agent.name} · ${formatScheduledTime(input.sendAt)}`,
        );
        scheduleSilentRefresh(400, gen);
      }
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleComposeMessage = useCallback(
    async (agent: ApiAgent, input: ComposeSubmit) => {
      if (client) {
        const gen = workspaceGenRef.current;
        await client.submitRun({
          agentId: agent.id,
          folderId: agent.folder_id ?? null,
          input: input.text,
          attachmentIds: input.attachmentIds,
          idempotencyKey: input.idempotencyKey,
        });
        showToast(
          input.attachmentIds?.length
            ? `Sent to @${agent.name} with ${input.attachmentIds.length} ${input.attachmentIds.length === 1 ? "file" : "files"}`
            : `Sent to @${agent.name}`,
        );
        setAppTab("feed");
        scheduleSilentRefresh(400, gen);
        return;
      }
      const nextCard = buildSimulatedReply(
        `conv-${agent.name}`,
        agent.name,
        "Loop Mobile",
        agent.model,
        input.text,
      );
      setDemoCards((prev) => [nextCard, ...prev]);
      setAppTab("feed");
      haptics.success();
      showToast(`@${agent.name} answered`);
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleComposeCreate = useCallback(
    async (input: PendingAgentCreate) => {
      if (client) {
        if (activeSessionRef.current !== session) {
          throw new LoopApiError(401, "Workspace changed.");
        }
        const gen = workspaceGenRef.current;
        const created = await client.createAgent({
          name: input.name,
          connectionId: input.connectionId,
          model: input.model,
          effort: input.effort,
          initialPrompt: input.text,
          attachmentIds: input.attachmentIds,
          folderId: input.folderId,
          idempotencyKey: input.idempotencyKey,
        });
        if (
          gen !== workspaceGenRef.current ||
          activeSessionRef.current !== session
        ) {
          throw new LoopApiError(401, "Workspace changed.");
        }
        showToast(`Started @${created.name}`);
        setAppTab("feed");
        scheduleSilentRefresh(400, gen);
        return;
      }
      const nextCard = buildSimulatedReply(
        `conv-${input.name}`,
        input.name,
        "Loop Mobile",
        "claude-sonnet-4",
        input.text,
      );
      setDemoCards((prev) => [nextCard, ...prev]);
      setAppTab("feed");
      haptics.success();
      showToast(`@${input.name} answered`);
    },
    [client, session, scheduleSilentRefresh, showToast],
  );

  const handleDecideApproval = useCallback(
    (id: string, decision: "approve" | "reject") => {
      if (!client) return;
      const gen = workspaceGenRef.current;
      const scopeKey = actionKeysRef.current.scopeForApproval(id, decision);
      const idempotencyKey = actionKeysRef.current.getOrCreate(scopeKey);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      void client
        .decideApproval(id, decision, idempotencyKey)
        .then(() => {
          if (gen === workspaceGenRef.current) {
            actionKeysRef.current.delete(scopeKey);
            showToast(decision === "approve" ? "Approved" : "Denied");
            scheduleSilentRefresh(400, gen);
          }
        })
        .catch((err) => {
          if (gen !== workspaceGenRef.current) return;
          if (isUncertainOutcomeError(err)) {
            showToast("Decision timed out — checking status…");
            scheduleSilentRefresh(600, gen);
            return;
          }
          actionKeysRef.current.delete(scopeKey);
          showToast((err as Error).message);
          scheduleSilentRefresh(100, gen);
        });
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleAnswerDecision = useCallback(
    (id: string, answer: Record<string, unknown>) => {
      if (!client) return;
      const gen = workspaceGenRef.current;
      const scopeKey = actionKeysRef.current.scopeForDecision(id, answer);
      const commandId = actionKeysRef.current.getOrCreate(scopeKey);
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      void client
        .answerNativeDecision(id, answer, commandId)
        .then(() => {
          if (gen === workspaceGenRef.current) {
            actionKeysRef.current.delete(scopeKey);
            showToast("Response sent");
            scheduleSilentRefresh(400, gen);
          }
        })
        .catch((err) => {
          if (gen !== workspaceGenRef.current) return;
          if (isUncertainOutcomeError(err)) {
            showToast("Response timed out — checking status…");
            scheduleSilentRefresh(600, gen);
            return;
          }
          actionKeysRef.current.delete(scopeKey);
          showToast((err as Error).message);
          scheduleSilentRefresh(100, gen);
        });
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleControlRun = useCallback(
    (runId: string, action: "pause" | "resume" | "cancel" | "retry") => {
      if (!client) {
        if (action === "cancel") {
          setDemoCards((prev) => prev.filter((c) => c.id !== runId));
        }
        showToast(
          action === "pause"
            ? "Paused run"
            : action === "resume"
              ? "Resumed run"
              : action === "retry"
                ? "Retried run"
                : "Stopped run",
        );
        return;
      }
      const gen = workspaceGenRef.current;
      const flightKey = `${action}:${runId}`;
      if (inFlightRunActionsRef.current.has(flightKey)) return;
      inFlightRunActionsRef.current.add(flightKey);

      // Keep one durable key per (runId, action) across uncertain timeouts until reconciled
      // by a definite response or a refreshed run state via `reconcileRunActions`.
      const scopeKey = actionKeysRef.current.scopeForRunAction(runId, action);
      const idempotencyKey = actionKeysRef.current.getOrCreate(scopeKey);
      const priorRun = activeRuns.find((r) => r.id === runId);
      if (action === "cancel") {
        setActiveRuns((prev) => prev.filter((r) => r.id !== runId));
        setCarouselOverrideCards((prev) =>
          prev
            ? prev.filter(
                (c) => c.runId !== runId && c.id !== `working:${runId}`,
              )
            : prev,
        );
        setQueuedFeedItems((prev) =>
          prev
            .map((item) => {
              const filteredQueued = item.queued_runs?.filter(
                (q) => q.id !== runId,
              );
              const nextRun =
                item.run?.id === runId && item.run.state === "queued"
                  ? null
                  : item.run;
              if (filteredQueued === item.queued_runs && nextRun === item.run) {
                return item;
              }
              return {
                ...item,
                run: nextRun,
                ...(filteredQueued ? { queued_runs: filteredQueued } : {}),
              };
            })
            .filter(
              (item) =>
                Boolean(item.run) ||
                Boolean(item.queued_runs && item.queued_runs.length > 0),
            ),
        );
        const hasOtherActiveInConv = Boolean(
          priorRun?.conversation_id &&
          activeRuns.some(
            (r) =>
              r.id !== runId &&
              r.conversation_id === priorRun.conversation_id &&
              r.state !== "queued",
          ),
        );
        if (
          clearRunFromLiveStreams(
            liveStreamsRef.current,
            runId,
            priorRun?.conversation_id,
            hasOtherActiveInConv,
          )
        ) {
          setLiveStreams(new Map(liveStreamsRef.current));
        }
      } else if (action === "pause" || action === "resume") {
        // Matches server `controlRun`: Pause transitions running -> pausing,
        // and Resume transitions paused -> queued (or completed if already answered).
        setActiveRuns((prev) =>
          prev.map((r) =>
            r.id === runId
              ? { ...r, state: action === "pause" ? "pausing" : "queued" }
              : r,
          ),
        );
        if (
          action === "resume" &&
          clearRunFromLiveStreams(
            liveStreamsRef.current,
            runId,
            priorRun?.conversation_id,
          )
        ) {
          setLiveStreams(new Map(liveStreamsRef.current));
        }
      } else if (action === "retry") {
        // Keep the failed/interrupted run visible until the server confirms retry so that
        // if retry times out or fails offline, the user can tap Retry again using the retained
        // durable idempotencyKey (double-taps while in flight are already blocked by `flightKey`).
      }
      void client
        .runAction(runId, action, idempotencyKey)
        .then(() => {
          if (gen !== workspaceGenRef.current) return;
          inFlightRunActionsRef.current.delete(flightKey);
          actionKeysRef.current.delete(scopeKey);
          if (action === "retry") {
            // Remove the retried failed/interrupted run immediately on server confirmation so a
            // second Retry tap before the 350ms refresh cannot create a duplicate run.
            setActiveRuns((prev) => prev.filter((r) => r.id !== runId));
          }
          showToast(
            action === "pause"
              ? "Pausing run…"
              : action === "resume"
                ? "Resumed run"
                : action === "retry"
                  ? "Retrying run…"
                  : "Stopped run",
          );
          scheduleSilentRefresh(350, gen);
        })
        .catch((err) => {
          if (gen !== workspaceGenRef.current) return;
          inFlightRunActionsRef.current.delete(flightKey);
          if (isUncertainOutcomeError(err)) {
            showToast("Run action timed out — checking status…");
            scheduleSilentRefresh(500, gen);
            return;
          }
          actionKeysRef.current.delete(scopeKey);
          // Re-sync from server instead of writing back a potentially stale tap-time snapshot.
          showToast((err as Error).message);
          scheduleSilentRefresh(50, gen);
        });
    },
    [activeRuns, client, scheduleSilentRefresh, showToast],
  );

  const handleReorderQueuedRun = useCallback(
    (runId: string, direction: "up" | "down") => {
      if (!client) return;
      const gen = workspaceGenRef.current;
      const flightKey = `reorder:${runId}`;
      const uncertainAt = uncertainReordersRef.current.get(runId);
      if (
        inFlightRunActionsRef.current.has(flightKey) ||
        (uncertainAt !== undefined && Date.now() - uncertainAt < 15_000)
      ) {
        return;
      }
      uncertainReordersRef.current.delete(runId);
      inFlightRunActionsRef.current.add(flightKey);
      void client
        .reorderRun(runId, direction)
        .then(() => {
          if (gen !== workspaceGenRef.current) return;
          inFlightRunActionsRef.current.delete(flightKey);
          scheduleSilentRefresh(200, gen);
        })
        .catch((err) => {
          if (gen !== workspaceGenRef.current) return;
          inFlightRunActionsRef.current.delete(flightKey);
          if (isUncertainOutcomeError(err)) {
            uncertainReordersRef.current.set(runId, Date.now());
            showToast("Reorder timed out — syncing queue…");
            scheduleSilentRefresh(500, gen);
            return;
          }
          showToast((err as Error).message);
          scheduleSilentRefresh(100, gen);
        });
    },
    [client, scheduleSilentRefresh, showToast],
  );

  const handleCancelQueuedRun = useCallback(
    (runId: string) => {
      handleControlRun(runId, "cancel");
    },
    [handleControlRun],
  );

  const handleSignOut = useCallback(async () => {
    const signingOutSession = session;
    if (client) await client.signOut();
    // Never wipe a newly paired workspace if the user switched while sign-out was in flight
    if (activeSessionRef.current !== signingOutSession) return;
    // Invalidate any in-flight workspace loads BEFORE deleting local cache files so
    // an about-to-finish fetchAll cannot recreate the cache file right after deletion.
    workspaceGenRef.current = loadCoordRef.current.reset();
    clearWorkspaceDrafts(signingOutSession?.origin);
    clearWorkspaceCache(signingOutSession?.origin);
    clearWorkspaceNotificationPrefs(signingOutSession?.origin);
    await clearPairedSession();
    if (activeSessionRef.current !== signingOutSession) return;
    setSession(null);
    setLiveCards([]);
    setSocketStatus("offline");
    showToast("Signed out — switched to Demo Deck");
  }, [client, session, showToast]);

  const openAgentByName = useCallback(
    (agentId: string | null | undefined, agentName: string) => {
      const cleanName = agentName.replace(/^@/, "");
      const found =
        (agentId && agents.find((a) => a.id === agentId)) ||
        agents.find((a) => a.name.toLowerCase() === cleanName.toLowerCase());
      if (found) {
        setProfileAgent(found);
        return;
      }
      if (client && agentId) {
        const gen = workspaceGenRef.current;
        void client
          .agentDetail(agentId)
          .then((detail) => {
            if (gen === workspaceGenRef.current && detail.agent) {
              setProfileAgent(detail.agent);
            }
          })
          .catch(() => {
            if (gen === workspaceGenRef.current) {
              showToast(`@${cleanName} is no longer available`);
            }
          });
        return;
      }
      showToast(`@${cleanName} is no longer available`);
    },
    [agents, client, showToast],
  );

  const handleOpenAgent = useCallback(
    (agent: ApiAgent, workingRun?: AgentRunSummary) => {
      if (!workingRun) {
        setProfileAgent(agent);
        return;
      }

      const convId = workingRun.conversation_id;
      const projectName =
        folders.find((f) => f.id === agent.folder_id)?.name || "Workspace";

      if (convId) {
        const existing = activeCards.find(
          (c) => c.conversationId === convId && c.tab === "working",
        );
        const cardId = existing?.id ?? `working:${workingRun.id || convId}`;
        const initialCard: NativeResultCard = existing ?? {
          id: cardId,
          conversationId: convId,
          tab: "working",
          agentId: agent.id,
          agentName: agent.name,
          projectName,
          model: agent.model || "",
          prompt: workingRun.input || `Working with @${agent.name}`,
          fallbackTitle: workingRun.input || `@${agent.name} is working`,
          body: "Working on your request… Live output will appear here as it arrives.",
          createdAt: workingRun.created_at || Date.now(),
          saved: false,
          unread: false,
          statusLabel: "Working",
          runId: workingRun.id,
          runState: workingRun.state,
        };
        setCarouselOverrideCards([initialCard]);
        setOpenConversationId(convId);

        if (client) {
          const gen = workspaceGenRef.current;
          void client
            .feed("working", { agent: agent.id })
            .then((page) => {
              if (gen !== workspaceGenRef.current) return;
              const match = page.items.find(
                (item) =>
                  item.conversation_id === convId ||
                  (workingRun.id && item.run?.id === workingRun.id),
              );
              if (!match) return;
              const liveCard = feedItemToNativeCard(match, "working");
              const hydratedCard: NativeResultCard = {
                ...liveCard,
                id: cardId,
                conversationId: convId,
                body: liveCard.body.trim() ? liveCard.body : initialCard.body,
              };
              setCarouselOverrideCards((prev) =>
                prev && prev[0]?.id === cardId ? [hydratedCard] : prev,
              );
            })
            .catch(() => {});
        }
        return;
      }

      if (client) {
        const gen = workspaceGenRef.current;
        void client
          .feed("working", { agent: agent.id })
          .then((page) => {
            if (gen !== workspaceGenRef.current) return;
            const match = workingRun.id
              ? page.items.find((item) => item.run?.id === workingRun.id)
              : page.items[0];
            if (match?.conversation_id) {
              const liveCard = feedItemToNativeCard(match, "working");
              setCarouselOverrideCards([liveCard]);
              setOpenConversationId(match.conversation_id);
            } else {
              setProfileAgent(agent);
            }
          })
          .catch(() => setProfileAgent(agent));
      } else {
        setProfileAgent(agent);
      }
    },
    [activeCards, client, folders],
  );

  const feedBadgeCount = useMemo(() => {
    if (client && summary) {
      return (
        (summary.needs ?? 0) +
        (summary.working ?? 0) +
        (summary.queued ?? 0) +
        (summary.done_unread ?? 0) +
        (summary.replies_unread ?? 0)
      );
    }
    return demoCards.filter((c) => c.unread).length;
  }, [client, summary, demoCards]);

  const selectBottomTab = (tab: AppTab) => {
    haptics.selection();
    if (tab === "feed" && appTab === "feed") {
      const now = Date.now();
      if (now - lastFeedTapRef.current < 450) {
        feedScrollRef.current?.scrollTo({ y: 0, animated: true });
      }
      lastFeedTapRef.current = now;
      return;
    }
    setAppTab(tab);
  };

  const handleOpenFile = useCallback(
    (file: PublishedFileItem) => {
      if (!client) {
        showToast("Pair with a Loop workspace to open files");
        return;
      }
      setPreviewFile(file);
    },
    [client, showToast],
  );

  const handleOpenFileTarget = useCallback(
    (target: LoopFileTarget, label?: string) => {
      if (!client) {
        showToast("Pair with a Loop workspace to open files");
        return;
      }
      const name = label?.trim() || "Published file";
      setPreviewFile({
        id: target.id,
        artifactId: target.kind === "artifact" ? target.id : undefined,
        title: name,
        name,
        mime: guessMimeFromName(name),
        size: 0,
        path: target.path,
      });
    },
    [client, showToast],
  );

  const openCarouselActiveRun = useMemo(() => {
    if (!openConversationId) return null;
    return (
      effectiveActiveRuns.find(
        (r) =>
          r.conversation_id === openConversationId &&
          [
            "running",
            "pausing",
            "paused",
            "awaiting_approval",
            "waiting_children",
            "failed",
            "interrupted",
          ].includes(r.state),
      ) ?? null
    );
  }, [effectiveActiveRuns, openConversationId]);

  const openCarouselQueuedRuns = useMemo(() => {
    if (!openConversationId || openCarouselCards.length === 0) return [];
    const agentId =
      openCarouselCards[0]?.agentId || openCarouselActiveRun?.agent_id || null;
    return buildAgentQueuedRuns(
      agentId,
      openConversationId,
      client ? queuedFeedItems : [],
      effectiveActiveRuns,
    );
  }, [
    client,
    effectiveActiveRuns,
    openCarouselActiveRun?.agent_id,
    openCarouselCards,
    openConversationId,
    queuedFeedItems,
  ]);

  const openCarouselCanPause = useMemo(
    () => canPauseRun(openCarouselActiveRun, agents, connections),
    [openCarouselActiveRun, agents, connections],
  );

  const openCarouselLiveStream = useMemo(() => {
    if (!openConversationId) return null;
    return (
      (openCarouselActiveRun &&
        liveStreams.get(`run:${openCarouselActiveRun.id}`)) ||
      liveStreams.get(`conv:${openConversationId}`) ||
      null
    );
  }, [liveStreams, openCarouselActiveRun, openConversationId]);

  const openThreadActiveRun = useMemo(() => {
    if (!threadOverlay) return null;
    return (
      effectiveActiveRuns.find(
        (r) =>
          r.conversation_id === threadOverlay.conversationId &&
          [
            "running",
            "pausing",
            "paused",
            "awaiting_approval",
            "waiting_children",
            "failed",
            "interrupted",
          ].includes(r.state),
      ) ?? null
    );
  }, [effectiveActiveRuns, threadOverlay]);

  const openThreadCanPause = useMemo(
    () => canPauseRun(openThreadActiveRun, agents, connections),
    [openThreadActiveRun, agents, connections],
  );

  const openThreadLiveStream = useMemo(() => {
    if (!threadOverlay) return null;
    return (
      (openThreadActiveRun &&
        liveStreams.get(`run:${openThreadActiveRun.id}`)) ||
      liveStreams.get(`conv:${threadOverlay.conversationId}`) ||
      null
    );
  }, [liveStreams, openThreadActiveRun, threadOverlay]);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <StatusBar style={darkMode ? "light" : "dark"} />

      {/* Active Primary Screen */}
      {appTab === "feed" && (
        <FeedScreen
          cards={activeCards}
          agents={agents}
          connections={connections}
          activeRuns={effectiveActiveRuns}
          approvals={approvals}
          decisions={decisions}
          isLive={Boolean(client)}
          environmentName={environmentName}
          socketStatus={socketStatus}
          showingCached={showingCachedSnapshot}
          cachedAt={cachedAt}
          refreshing={refreshing}
          hasMore={Boolean(client && feedCursor)}
          loadingMore={loadingMoreFeed}
          theme={theme}
          scrollRef={feedScrollRef}
          onRefresh={() => {
            if (client) void loadWorkspace({ silent: false });
            else {
              setDemoCards(createInitialCards());
              showToast("Demo deck refreshed");
            }
          }}
          onLoadMore={() => void handleLoadMoreFeed()}
          onOpenPairing={() => setPairingOpen(true)}
          onOpenAgent={handleOpenAgent}
          onOpenAgentByName={openAgentByName}
          onNewAgent={() => setComposeTarget({ kind: "new" })}
          onOpenStack={(conversationId) => {
            setCarouselOverrideCards(null);
            setOpenConversationId(conversationId);
          }}
          onSwipeDone={handleDismissCard}
          onSwipeSave={(card) => {
            void handleToggleSaved(card).catch(() => {});
          }}
          onDecideApproval={handleDecideApproval}
          onAnswerDecision={handleAnswerDecision}
        />
      )}

      {appTab === "projects" && (
        <ProjectsScreen
          client={client}
          folders={folders}
          agents={agents}
          localCards={activeCards}
          theme={theme}
          onOpenConversation={(conv) => setThreadOverlay(conv)}
          onOpenAgent={(agent) => setProfileAgent(agent)}
          onNewTaskInProject={(folderId) =>
            setComposeTarget({
              kind: "new",
              folderId,
              folderName: folders.find((f) => f.id === folderId)?.name,
            })
          }
        />
      )}

      {appTab === "pulls" && (
        <PullRequestsScreen
          client={client}
          theme={theme}
          onOpenConversation={(conv) => setThreadOverlay(conv)}
        />
      )}

      {appTab === "search" && (
        <SearchScreen
          client={client}
          agents={agents}
          localCards={activeCards}
          theme={theme}
          onOpenConversation={(conv) => setThreadOverlay(conv)}
          onOpenAgent={(agent) => setProfileAgent(agent)}
        />
      )}

      {appTab === "profile" && (
        <ProfileScreen
          client={client}
          session={session}
          socketStatus={socketStatus}
          localCards={activeCards}
          theme={theme}
          onToggleTheme={() => setDarkMode((v) => !v)}
          onOpenPairing={() => setPairingOpen(true)}
          onSignOut={() => void handleSignOut()}
          onOpenConversation={(conv) => setThreadOverlay(conv)}
          onOpenFile={handleOpenFile}
          notificationPrefs={notificationPrefs}
          notificationPrefsLoaded={notificationPrefsLoaded}
          onChangeNotificationPrefs={(next) => {
            if (!notificationPrefsLoaded) return;
            setNotificationPrefs(next);
            saveNotificationPrefs(client?.origin, next);
          }}
        />
      )}

      {!isCarouselOpen && (
        <View pointerEvents="box-none" style={styles.tabDock}>
          <View pointerEvents="none" style={styles.tabDockBackdrop}>
            <Svg
              width="100%"
              height={TAB_FADE_HEIGHT}
              viewBox={`0 0 1 ${TAB_FADE_HEIGHT}`}
              preserveAspectRatio="none"
            >
              <Defs>
                <LinearGradient
                  id="tabDockFade"
                  x1="0%"
                  y1="0%"
                  x2="0%"
                  y2="100%"
                >
                  <Stop offset="0" stopColor={theme.bg} stopOpacity={0} />
                  <Stop offset="1" stopColor={theme.bg} />
                </LinearGradient>
              </Defs>
              <Rect
                width={1}
                height={TAB_FADE_HEIGHT}
                fill="url(#tabDockFade)"
              />
            </Svg>
            <View
              style={[styles.tabDockGround, { backgroundColor: theme.bg }]}
            />
          </View>
          <View
            style={[
              styles.tabBar,
              {
                marginLeft: Math.max(insets.left, 16),
                marginRight: Math.max(insets.right, 16),
                marginBottom: tabBarBottom,
                backgroundColor: theme.tabBarBg,
                borderColor: theme.tabBarLine,
              },
            ]}
          >
            <BottomTabButton
              label="Feed"
              active={appTab === "feed"}
              badge={feedBadgeCount}
              theme={theme}
              icon={Inbox}
              onPress={() => selectBottomTab("feed")}
            />
            <BottomTabButton
              label="Projects"
              active={appTab === "projects"}
              theme={theme}
              icon={Folder}
              onPress={() => selectBottomTab("projects")}
            />
            <BottomTabButton
              label="PRs"
              active={appTab === "pulls"}
              theme={theme}
              icon={GitPullRequest}
              onPress={() => selectBottomTab("pulls")}
            />
            <BottomTabButton
              label="Search"
              active={appTab === "search"}
              theme={theme}
              icon={Search}
              onPress={() => selectBottomTab("search")}
            />
            <BottomTabButton
              label="Profile"
              active={appTab === "profile"}
              theme={theme}
              icon={UserRound}
              onPress={() => selectBottomTab("profile")}
            />
          </View>
        </View>
      )}

      {/* Spotlight Stage Floating Carousel */}
      {openConversationId && openCarouselCards.length > 0 && (
        <SpotlightCarousel
          key={openConversationId}
          cards={openCarouselCards}
          openingCard={carouselOverrideCards?.[0]}
          queuedRuns={openCarouselQueuedRuns}
          activeRun={openCarouselActiveRun}
          canPause={openCarouselCanPause}
          liveStream={openCarouselLiveStream}
          client={client}
          snippets={sortedSnippets}
          theme={theme}
          onCancelQueuedRun={handleCancelQueuedRun}
          onReorderQueuedRun={handleReorderQueuedRun}
          onControlRun={handleControlRun}
          onClose={() => {
            setOpenConversationId(null);
            setCarouselOverrideCards(null);
          }}
          onOpenAgent={(agentId, agentName) => {
            setOpenConversationId(null);
            setCarouselOverrideCards(null);
            openAgentByName(agentId, agentName);
          }}
          onOpenThread={(card) => {
            setOpenConversationId(null);
            setCarouselOverrideCards(null);
            setThreadOverlay({
              conversationId: card.conversationId,
              title: card.fallbackTitle,
              agentName: card.agentName,
              agentId: card.agentId,
            });
          }}
          onOpenFile={handleOpenFile}
          onOpenFileTarget={handleOpenFileTarget}
          onMarkRead={handleMarkRead}
          onToggleSaved={handleToggleSaved}
          onRemind={(card) => setRemindCard(card)}
          onDismissCard={handleDismissCard}
          onNotify={showToast}
          onSendReply={handleCarouselReply}
          onScheduleReply={handleCarouselSchedule}
        />
      )}

      {/* Full Chronological Thread Sheet */}
      {threadOverlay && (
        <ThreadSheet
          key={threadOverlay.conversationId}
          conversationId={threadOverlay.conversationId}
          title={threadOverlay.title}
          agentName={threadOverlay.agentName}
          agentId={threadOverlay.agentId}
          client={client}
          activeRun={openThreadActiveRun}
          canPause={openThreadCanPause}
          liveStream={openThreadLiveStream}
          fallbackCards={activeCards.filter(
            (c) => c.conversationId === threadOverlay.conversationId,
          )}
          refreshKey={workspaceVersion}
          theme={theme}
          onClose={() => setThreadOverlay(null)}
          onControlRun={handleControlRun}
          onOpenFile={handleOpenFile}
          onOpenFileTarget={handleOpenFileTarget}
          onSendLiveReply={async (input) => {
            if (client) {
              const agentId =
                input.agentId ||
                agents.find((a) => a.name === input.agentName)?.id ||
                agents[0]?.id;
              if (!agentId) throw new Error("No agent found for this thread");
              await client.submitRun({
                agentId,
                conversationId: input.conversationId,
                input: input.text,
                attachmentIds: input.attachmentIds,
                idempotencyKey: input.idempotencyKey,
                queue: input.queue,
              });
              showToast(
                input.queue
                  ? `Queued for @${input.agentName}`
                  : input.attachmentIds?.length
                    ? `Sent to @${input.agentName} with ${input.attachmentIds.length} ${input.attachmentIds.length === 1 ? "file" : "files"}`
                    : `Sent to @${input.agentName}`,
              );
            } else {
              const nextCard = buildSimulatedReply(
                input.conversationId,
                input.agentName,
                "Loop Mobile",
                "claude-sonnet-4",
                input.text,
              );
              setDemoCards((prev) => [nextCard, ...prev]);
              haptics.success();
            }
          }}
          onScheduleReply={
            client
              ? async (input) => {
                  const gen = workspaceGenRef.current;
                  const agentId =
                    input.agentId ||
                    agents.find((a) => a.name === input.agentName)?.id ||
                    agents[0]?.id;
                  if (!agentId)
                    throw new Error("No agent found for this thread");
                  await client.createScheduledSend({
                    agentId,
                    conversationId: input.conversationId,
                    input: input.text,
                    attachmentIds: input.attachmentIds ?? [],
                    idempotencyKey: input.idempotencyKey,
                    sendAt: input.sendAt,
                  });
                  if (gen === workspaceGenRef.current) {
                    haptics.success();
                    showToast(
                      `Scheduled for @${input.agentName} · ${formatScheduledTime(input.sendAt)}`,
                    );
                    scheduleSilentRefresh(400, gen);
                  }
                }
              : undefined
          }
          onToggleSaved={async (msgId, currentlySaved) => {
            if (client) {
              await client.setSaved(msgId, !currentlySaved);
              showToast(!currentlySaved ? "Saved" : "Unsaved");
            } else {
              setDemoCards((prev) =>
                prev.map((c) =>
                  c.id === msgId ? { ...c, saved: !currentlySaved } : c,
                ),
              );
            }
          }}
        />
      )}

      {/* Agent Profile Sheet (Illustrated Habitat Cover + Results / Threads / Traces) */}
      {profileAgent && (
        <AgentProfileSheet
          agent={profileAgent}
          connections={connections}
          client={client}
          folders={folders}
          activeRuns={effectiveActiveRuns}
          allCards={activeCards}
          theme={theme}
          onClose={() => setProfileAgent(null)}
          onUpdateModel={
            client
              ? async (selection) => {
                  const gen = workspaceGenRef.current;
                  const updated = await client.updateAgentModel(
                    profileAgent.id,
                    selection,
                  );
                  if (gen !== workspaceGenRef.current) return;
                  setAgents((prev) =>
                    prev.map((agent) =>
                      agent.id === updated.id ? updated : agent,
                    ),
                  );
                  setProfileAgent((prev) =>
                    prev?.id === updated.id ? updated : prev,
                  );
                  void loadWorkspaceRef.current({ silent: true });
                }
              : undefined
          }
          onMessageAgent={(agent) => {
            setProfileAgent(null);
            setComposeTarget({ kind: "agent", agent });
          }}
          onOpenStack={(conversationId, seedCard) => {
            setProfileAgent(null);
            setCarouselOverrideCards(seedCard ? [seedCard] : null);
            setOpenConversationId(conversationId);
          }}
          onOpenThread={(conv) => {
            setProfileAgent(null);
            setThreadOverlay(conv);
          }}
        />
      )}

      {/* New Task / Compose Sheet */}
      {composeTarget && (
        <ComposeSheet
          key={JSON.stringify([
            session?.origin,
            session?.deviceId,
            session?.pairedAt,
          ])}
          theme={theme}
          client={client}
          connections={connections}
          target={composeTarget}
          onClose={() => setComposeTarget(null)}
          onMessage={handleComposeMessage}
          onSchedule={handleComposeSchedule}
          onCreate={handleComposeCreate}
        />
      )}

      {/* Remind Me Sheet */}
      {remindCard && (
        <RemindSheet
          theme={theme}
          title={remindCard.fallbackTitle}
          onClose={() => setRemindCard(null)}
          onPick={(choice) => void handlePickReminder(choice)}
        />
      )}

      {/* Native Agent-Published File Preview & Save/Share Modal */}
      {previewFile && client && (
        <FilePreviewModal
          file={previewFile}
          client={client}
          theme={theme}
          onClose={() => setPreviewFile(null)}
          onOpenConversation={(conv) => {
            setOpenConversationId(null);
            setCarouselOverrideCards(null);
            setThreadOverlay(conv);
          }}
        />
      )}

      {/* Incoming OS Share Sheet ("Bring into Loop") */}
      {incomingShare && !pairingOpen && (
        <ShareInboxSheet
          key={incomingShare.fingerprint}
          share={incomingShare}
          client={client}
          agents={agents}
          folders={folders}
          theme={theme}
          onClose={dismissIncomingShare}
          onOpenPairing={() => {
            setPairingOpen(true);
          }}
          onSent={(message, conversationId, agentName) => {
            const gen = workspaceGenRef.current;
            dismissIncomingShare();
            showToast(message);
            scheduleSilentRefresh(350, gen);
            if (conversationId) {
              setThreadOverlay({
                conversationId,
                title: incomingShare.sourceTitle || "Shared conversation",
                agentName: agentName || "agent",
              });
            }
          }}
        />
      )}

      {/* QR / Link Pairing Modal */}
      {pairingOpen && (
        <PairingModal
          theme={theme}
          canClose
          initialUrl={pairingInitialUrl}
          onClose={() => {
            setPairingOpen(false);
            setPairingInitialUrl("");
          }}
          onPaired={async (nextSession) => {
            const previous = activeSessionRef.current;
            const newDevice = !isSamePairedDevice(previous, nextSession);
            // A URL probe can reuse the same device. Clear local data only
            // when the server's paired device identity changes.
            if (newDevice) clearPairedWorkspaceData(nextSession.origin, true);
            // Persist the new credential only after the target's old drafts
            // are gone, so a restart mid-pairing cannot expose them.
            await savePairedSession(nextSession);
            if (
              newDevice &&
              previous &&
              previous.origin !== nextSession.origin
            ) {
              clearPairedWorkspaceData(previous.origin);
            }
            setComposeTarget(null);
            setSession(nextSession);
            setPairingOpen(false);
            setPairingInitialUrl("");
            showToast(
              `Paired with ${nextSession.origin.replace(/^https?:\/\//, "")}`,
            );
          }}
        />
      )}

      {/* Tactile Toast with optional Undo */}
      {toast && (
        <View
          pointerEvents="box-none"
          style={[styles.toastWrap, { bottom: tabBarBottom + 72 }]}
        >
          <View
            style={[
              styles.toastPill,
              {
                backgroundColor: theme.raised,
                borderColor: theme.attentionLine,
              },
            ]}
          >
            <Text style={[styles.toastText, { color: theme.text }]}>
              {toast.text}
            </Text>
            {toast.undo && (
              <Pressable
                onPress={() => {
                  const fn = toast.undo;
                  setToast(null);
                  fn?.();
                }}
                style={[styles.undoBtn, { backgroundColor: theme.attention }]}
              >
                <Text style={[styles.undoText, { color: theme.brassText }]}>
                  Undo
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function BottomTabButton({
  label,
  active,
  badge,
  icon: Icon,
  theme,
  onPress,
}: {
  label: string;
  active: boolean;
  badge?: number;
  icon: typeof Inbox;
  theme: typeof DARK_THEME;
  onPress: () => void;
}) {
  const color = active ? theme.tabBarActiveText : theme.text;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[
        styles.tabBtn,
        active && { backgroundColor: theme.tabBarActiveBg },
      ]}
    >
      <View style={styles.tabIconWrap}>
        <Icon size={20} color={color} />
        {!!badge && badge > 0 && (
          <View
            style={[
              styles.tabBarBadge,
              { backgroundColor: theme.orange, borderColor: theme.surface },
            ]}
          >
            <Text
              style={[
                styles.tabBarBadgeText,
                { color: theme.isDark ? theme.onBrass : "#ffffff" },
              ]}
            >
              {badge > 9 ? "9+" : badge}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.tabBtnLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const TAB_FADE_HEIGHT = 22;

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 15,
  },
  tabDockBackdrop: {
    ...StyleSheet.absoluteFill,
    top: -TAB_FADE_HEIGHT,
  },
  tabDockGround: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 62,
    padding: 6,
    borderWidth: 1,
    borderRadius: 22,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  tabBtn: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 4,
    borderRadius: 16,
  },
  tabIconWrap: {
    position: "relative",
  },
  tabBarBadge: {
    position: "absolute",
    top: -5,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBarBadgeText: {
    fontSize: 9.5,
    fontWeight: "800",
  },
  tabBtnLabel: {
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
  toastWrap: {
    position: "absolute",
    left: 20,
    right: 20,
    alignItems: "center",
    zIndex: 70,
  },
  toastPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 14,
    paddingRight: 10,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  toastText: {
    fontSize: 13,
    fontWeight: "600",
  },
  undoBtn: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  undoText: {
    fontSize: 12,
    fontWeight: "700",
  },
});
