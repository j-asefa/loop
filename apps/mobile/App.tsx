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
import { BlurView } from "expo-blur";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  Folder,
  GitPullRequest,
  Inbox,
  Plus,
  Search,
  UserRound,
} from "lucide-react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { LoopClient } from "./src/api/client";
import { clearPairedSession, loadPairedSession } from "./src/api/pairing";
import { LoopEventSocket, type SocketStatus } from "./src/api/socket";
import type {
  ApiAgent,
  ApiApproval,
  ApiFeedSummary,
  ApiFolder,
  ApiNativeDecision,
  ApiSnippet,
  PairedSession,
} from "./src/api/types";
import {
  AgentProfileSheet,
  type AgentRunSummary,
} from "./src/components/AgentProfileSheet";
import { ComposeSheet } from "./src/components/ComposeSheet";
import { FeedScreen } from "./src/components/FeedScreen";
import { PairingModal } from "./src/components/PairingModal";
import { ProfileScreen } from "./src/components/ProfileScreen";
import { ProjectsScreen } from "./src/components/ProjectsScreen";
import { PullRequestsScreen } from "./src/components/PullRequestsScreen";
import { RemindSheet, type RemindChoice } from "./src/components/RemindSheet";
import { SearchScreen } from "./src/components/SearchScreen";
import { SpotlightCarousel } from "./src/components/SpotlightCarousel";
import { ThreadSheet } from "./src/components/ThreadSheet";
import {
  buildSimulatedReply,
  createInitialCards,
  feedItemToNativeCard,
  type FeedTab,
  type NativeResultCard,
} from "./src/fixtures";
import { haptics } from "./src/haptics";
import { DARK_THEME, LIGHT_THEME } from "./src/theme";

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
  const [darkMode, setDarkMode] = useState(true);
  const theme = darkMode ? DARK_THEME : LIGHT_THEME;

  // Companion session (Keychain-backed)
  const [session, setSession] = useState<PairedSession | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("offline");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingInitialUrl, setPairingInitialUrl] = useState("");

  // Navigation
  const [appTab, setAppTab] = useState<AppTab>("feed");
  const [feedTab, setFeedTab] = useState<FeedTab>("done");
  const feedScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lastFeedTapRef = useRef(0);

  // Workspace state (live or demo fallback)
  const [demoCards, setDemoCards] = useState<NativeResultCard[]>(() =>
    createInitialCards(),
  );
  const [liveCards, setLiveCards] = useState<NativeResultCard[]>([]);
  const [summary, setSummary] = useState<ApiFeedSummary | null>(null);
  const [agents, setAgents] = useState<ApiAgent[]>(DEMO_AGENTS);
  const [folders, setFolders] = useState<ApiFolder[]>([]);
  const [snippets, setSnippets] = useState<ApiSnippet[]>([]);
  const [approvals, setApprovals] = useState<ApiApproval[]>([]);
  const [decisions, setDecisions] = useState<ApiNativeDecision[]>([]);
  const [activeRuns, setActiveRuns] = useState<AgentRunSummary[]>([]);
  const [environmentName, setEnvironmentName] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

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
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeAgentId, setComposeAgentId] = useState<string | undefined>(
    undefined,
  );
  const [composeFolderId, setComposeFolderId] = useState<string | null>(null);
  const [remindCard, setRemindCard] = useState<NativeResultCard | null>(null);

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
    void loadPairedSession().then((saved) => {
      if (saved) setSession(saved);
    });
    const inspectUrl = (incoming: string | null | undefined) => {
      if (!incoming) return;
      if (
        incoming.includes("#pair=") ||
        incoming.includes("?pair=") ||
        incoming.includes("#fleet=")
      ) {
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
    return () => sub.remove();
  }, []);

  const handleUnauthorized = useCallback(() => {
    void clearPairedSession();
    setSession(null);
    setSocketStatus("offline");
    setPairingOpen(true);
    showToast("Session expired — pair this phone again");
  }, [showToast]);

  const client = useMemo(
    () => (session ? new LoopClient(session, handleUnauthorized) : null),
    [session, handleUnauthorized],
  );

  const feedTabRef = useRef<FeedTab>(feedTab);
  feedTabRef.current = feedTab;
  const loadingInFlightRef = useRef(false);
  const sessionRefreshedRef = useRef(false);

  const loadWorkspace = useCallback(
    async (
      tabToLoad: FeedTab = feedTabRef.current,
      options?: { silent?: boolean },
    ) => {
      if (!client) return;
      const silent = options?.silent ?? true;
      if (silent && loadingInFlightRef.current) return;
      loadingInFlightRef.current = true;
      if (!silent) setRefreshing(true);
      try {
        if (!sessionRefreshedRef.current || !silent) {
          await client.refreshSession().catch(() => {});
          sessionRefreshedRef.current = true;
        }
        const [boot, feedPage, appList, decList, snipList, runList] =
          await Promise.all([
            client.bootstrap(),
            client.feed(tabToLoad),
            client.approvals().catch(() => [] as ApiApproval[]),
            client.nativeDecisions().catch(() => [] as ApiNativeDecision[]),
            client.snippets().catch(() => [] as ApiSnippet[]),
            client.runs(true).catch(() => [] as AgentRunSummary[]),
          ]);
        // Drop stale response if user already switched feed tabs while loading
        if (tabToLoad !== feedTabRef.current) return;
        setAgents(boot.agents);
        setFolders(boot.folders);
        setEnvironmentName(boot.environmentName || "");
        setSummary(feedPage.summary);
        setLiveCards(
          feedPage.items.map((item) => feedItemToNativeCard(item, tabToLoad)),
        );
        setApprovals(appList);
        setDecisions(decList);
        setSnippets(snipList);
        setActiveRuns(runList);
      } catch (err) {
        if (!silent && err instanceof Error && !err.message.includes("401")) {
          showToast(err.message);
        }
      } finally {
        loadingInFlightRef.current = false;
        if (!silent) setRefreshing(false);
      }
    },
    [client, showToast],
  );

  const loadWorkspaceRef = useRef(loadWorkspace);
  loadWorkspaceRef.current = loadWorkspace;

  // Fetch silently on session or tab change (never triggers pull-to-refresh spinner)
  useEffect(() => {
    if (!client) {
      sessionRefreshedRef.current = false;
      setAgents(DEMO_AGENTS);
      setFolders([]);
      setApprovals([]);
      setDecisions([]);
      setSnippets([]);
      setSummary(null);
      setSocketStatus("offline");
      return;
    }
    void loadWorkspace(feedTab, { silent: true });
  }, [client, feedTab, loadWorkspace]);

  // Live WebSocket updates when paired — stable across tab switches
  useEffect(() => {
    if (!session || !client) return;
    const sock = new LoopEventSocket(
      session,
      () => void loadWorkspaceRef.current(feedTabRef.current, { silent: true }),
      setSocketStatus,
    );
    sock.start();
    return () => sock.stop();
  }, [session, client]);

  const activeCards = client ? liveCards : demoCards;

  const effectiveActiveRuns = useMemo<AgentRunSummary[]>(() => {
    if (client) return activeRuns;
    return demoCards
      .filter((c) => c.tab === "working" && c.agentId)
      .map((c) => ({
        id: c.id,
        agent_id: c.agentId!,
        conversation_id: c.conversationId,
        state: "running",
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
    if (overrides.length === 0) return matching;
    const seenIds = new Set(overrides.map((c) => c.id));
    const seenMsgs = new Set(
      overrides.map((c) => c.messageId).filter((m): m is string => Boolean(m)),
    );
    const seenRuns = new Set(
      overrides.map((c) => c.runId).filter((r): r is string => Boolean(r)),
    );
    const merged = [...overrides];
    for (const c of matching) {
      if (seenIds.has(c.id)) continue;
      if (c.messageId && seenMsgs.has(c.messageId)) continue;
      if (c.tab === "working" && c.runId && seenRuns.has(c.runId)) continue;
      merged.push(c);
    }
    return merged;
  }, [activeCards, carouselOverrideCards, openConversationId]);

  const handleMarkRead = useCallback(
    (card: NativeResultCard) => {
      if (client) {
        setLiveCards((prev) =>
          prev.map((c) => (c.id === card.id ? { ...c, unread: false } : c)),
        );
        if (card.doneCardKey) {
          void client
            .markDoneRead(
              card.conversationId,
              card.doneCardKey,
              card.unreadVersion,
            )
            .catch(() => {});
        } else if (card.replyCardKey && card.messageId) {
          void client
            .setReplyState(card.messageId, { read: true })
            .catch(() => {});
        }
        return;
      }
      setDemoCards((prev) =>
        prev.map((c) => (c.id === card.id ? { ...c, unread: false } : c)),
      );
    },
    [client],
  );

  const handleToggleSaved = useCallback(
    (card: NativeResultCard) => {
      const nextSaved = !card.saved;
      const updater = (prev: NativeResultCard[]) =>
        prev.map((c) => (c.id === card.id ? { ...c, saved: nextSaved } : c));
      if (client) {
        setLiveCards(updater);
        if (card.messageId) {
          void client
            .setSaved(card.messageId, nextSaved)
            .then(() =>
              showToast(nextSaved ? "Saved card" : "Removed from Saved"),
            )
            .catch((err) => showToast((err as Error).message));
        }
        return;
      }
      setDemoCards(updater);
      showToast(nextSaved ? "Saved card" : "Removed from Saved");
    },
    [client, showToast],
  );

  const handleDismissCard = useCallback(
    (card: NativeResultCard) => {
      if (client) {
        setLiveCards((prev) => prev.filter((c) => c.id !== card.id));
        if (card.doneCardKey) {
          void client
            .setDoneHidden(card.conversationId, card.doneCardKey, true)
            .catch(() => {});
          showToast("Marked done", () => {
            haptics.light();
            void client
              .setDoneHidden(card.conversationId, card.doneCardKey!, false)
              .then(() => void loadWorkspace(feedTab));
          });
        } else if (card.replyCardKey && card.messageId) {
          void client
            .setReplyState(card.messageId, { archived: true })
            .catch(() => {});
          showToast("Archived reply", () => {
            haptics.light();
            void client
              .setReplyState(card.messageId!, { archived: false })
              .then(() => void loadWorkspace(feedTab));
          });
        }
        return;
      }
      setDemoCards((prev) => prev.filter((c) => c.id !== card.id));
      showToast(`Marked @${card.agentName} card done`, () => {
        haptics.light();
        setDemoCards((prev) => [card, ...prev]);
      });
    },
    [client, feedTab, loadWorkspace, showToast],
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
    ) => {
      if (client) {
        const agentId =
          card.agentId ||
          agents.find((a) => a.name === card.agentName)?.id ||
          agents[0]?.id;
        if (!agentId) {
          showToast("No agent available to receive this reply");
          return;
        }
        await client.submitRun({
          agentId,
          conversationId: card.conversationId,
          replyToMessageId: card.messageId,
          input: prompt,
          attachmentIds,
        });
        showToast(
          attachmentIds?.length
            ? `Sent to @${card.agentName} with ${attachmentIds.length} ${attachmentIds.length === 1 ? "file" : "files"}`
            : `Sent to @${card.agentName}`,
        );
        setTimeout(() => void loadWorkspace(feedTab), 450);
        return;
      }
      setTimeout(() => {
        const nextCard = buildSimulatedReply(
          card.conversationId,
          card.agentName,
          card.projectName,
          card.model,
          prompt,
        );
        setDemoCards((prev) => [nextCard, ...prev]);
        haptics.success();
      }, 1100);
    },
    [client, agents, feedTab, loadWorkspace, showToast],
  );

  const handleComposeSend = useCallback(
    async (input: {
      agentId: string;
      agentName: string;
      folderId?: string | null;
      text: string;
      attachmentIds?: string[];
    }) => {
      if (client) {
        await client.submitRun({
          agentId: input.agentId,
          folderId: input.folderId,
          input: input.text,
          attachmentIds: input.attachmentIds,
        });
        showToast(
          input.attachmentIds?.length
            ? `Sent to @${input.agentName} with ${input.attachmentIds.length} ${input.attachmentIds.length === 1 ? "file" : "files"}`
            : `Sent to @${input.agentName}`,
        );
        setAppTab("feed");
        setTimeout(() => void loadWorkspace(feedTab), 400);
        return;
      }
      const nextCard = buildSimulatedReply(
        `conv-${input.agentName}`,
        input.agentName,
        "Loop Mobile",
        "claude-sonnet-4",
        input.text,
      );
      setDemoCards((prev) => [nextCard, ...prev]);
      setAppTab("feed");
      setFeedTab("done");
      haptics.success();
      showToast(`@${input.agentName} answered`);
    },
    [client, feedTab, loadWorkspace, showToast],
  );

  const handleDecideApproval = useCallback(
    (id: string, decision: "approve" | "reject") => {
      if (!client) return;
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      void client
        .decideApproval(id, decision)
        .then(() => {
          showToast(decision === "approve" ? "Approved" : "Denied");
          setTimeout(() => void loadWorkspace(feedTab), 400);
        })
        .catch((err) => showToast((err as Error).message));
    },
    [client, feedTab, loadWorkspace, showToast],
  );

  const handleAnswerDecision = useCallback(
    (id: string, answer: Record<string, unknown>) => {
      if (!client) return;
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      void client
        .answerNativeDecision(id, answer)
        .then(() => {
          showToast("Response sent");
          setTimeout(() => void loadWorkspace(feedTab), 400);
        })
        .catch((err) => showToast((err as Error).message));
    },
    [client, feedTab, loadWorkspace, showToast],
  );

  const handleSignOut = useCallback(async () => {
    if (client) await client.signOut();
    await clearPairedSession();
    setSession(null);
    setLiveCards([]);
    setSocketStatus("offline");
    showToast("Signed out — switched to Demo Deck");
  }, [client, showToast]);

  const openAgentByName = useCallback(
    (agentId: string | null | undefined, agentName: string) => {
      const found =
        (agentId && agents.find((a) => a.id === agentId)) ||
        agents.find(
          (a) =>
            a.name.toLowerCase() === agentName.replace(/^@/, "").toLowerCase(),
        );
      if (found) {
        setProfileAgent(found);
      } else {
        setProfileAgent({
          id: agentId || agentName,
          name: agentName.replace(/^@/, ""),
          provider: "anthropic",
          connection_id: null,
          model: "",
          instructions: "",
        });
      }
    },
    [agents],
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
          void client
            .feed("working", { agent: agent.id })
            .then((page) => {
              const match =
                page.items.find(
                  (item) =>
                    item.conversation_id === convId ||
                    (workingRun.id && item.run?.id === workingRun.id),
                ) ?? page.items[0];
              if (!match) return;
              const liveCard = feedItemToNativeCard(match, "working");
              const hydratedCard: NativeResultCard = {
                ...liveCard,
                id: cardId,
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
        void client
          .feed("working", { agent: agent.id })
          .then((page) => {
            const match =
              page.items.find(
                (item) => workingRun.id && item.run?.id === workingRun.id,
              ) ?? page.items[0];
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
        setFeedTab("done");
        feedScrollRef.current?.scrollTo({ y: 0, animated: true });
      }
      lastFeedTapRef.current = now;
      return;
    }
    setAppTab(tab);
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <StatusBar style={darkMode ? "light" : "dark"} />

      {/* Active Primary Screen */}
      {appTab === "feed" && (
        <FeedScreen
          cards={activeCards}
          agents={agents}
          activeRuns={effectiveActiveRuns}
          activeTab={feedTab}
          summary={summary}
          approvals={approvals}
          decisions={decisions}
          isLive={Boolean(client)}
          environmentName={environmentName}
          socketStatus={socketStatus}
          refreshing={refreshing}
          theme={theme}
          scrollRef={feedScrollRef}
          onRefresh={() => {
            if (client) void loadWorkspace(feedTab, { silent: false });
            else {
              setDemoCards(createInitialCards());
              showToast("Demo deck refreshed");
            }
          }}
          onSelectTab={setFeedTab}
          onOpenPairing={() => setPairingOpen(true)}
          onOpenAgent={handleOpenAgent}
          onOpenAgentByName={openAgentByName}
          onNewAgent={() => {
            setComposeAgentId(undefined);
            setComposeFolderId(null);
            setComposeOpen(true);
          }}
          onOpenStack={(conversationId) => {
            setCarouselOverrideCards(null);
            setOpenConversationId(conversationId);
          }}
          onSwipeDone={handleDismissCard}
          onSwipeSave={handleToggleSaved}
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
          onNewTaskInProject={(folderId) => {
            setComposeAgentId(undefined);
            setComposeFolderId(folderId);
            setComposeOpen(true);
          }}
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
        />
      )}

      {/* Floating + New Task Button */}
      {!openConversationId &&
        !profileAgent &&
        !threadOverlay &&
        !composeOpen &&
        !pairingOpen && (
          <Pressable
            accessibilityLabel="New task"
            onPress={() => {
              haptics.medium();
              setComposeAgentId(undefined);
              setComposeFolderId(null);
              setComposeOpen(true);
            }}
            style={({ pressed }) => [
              styles.fab,
              {
                bottom: Math.max(insets.bottom + 72, 82),
                backgroundColor: theme.brass,
                transform: [{ scale: pressed ? 0.92 : 1 }],
              },
            ]}
          >
            <Plus size={24} color={theme.onBrass} strokeWidth={2.5} />
          </Pressable>
        )}

      {/* Frosted Native 5-Tab Bottom Bar */}
      <View
        style={[
          styles.tabBarOuter,
          {
            paddingBottom: Math.max(insets.bottom, 10),
            borderTopColor: theme.line,
          },
        ]}
      >
        <BlurView
          intensity={75}
          tint={theme.blurTint}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: theme.isDark
                ? "rgba(20, 20, 18, 0.72)"
                : "rgba(255, 255, 255, 0.78)",
            },
          ]}
        />

        <BottomTabButton
          label="Feed"
          active={appTab === "feed"}
          badge={feedBadgeCount}
          theme={theme}
          icon={
            <Inbox
              size={20}
              color={appTab === "feed" ? theme.brassText : theme.muted}
            />
          }
          onPress={() => selectBottomTab("feed")}
        />
        <BottomTabButton
          label="Projects"
          active={appTab === "projects"}
          theme={theme}
          icon={
            <Folder
              size={20}
              color={appTab === "projects" ? theme.brassText : theme.muted}
            />
          }
          onPress={() => selectBottomTab("projects")}
        />
        <BottomTabButton
          label="PRs"
          active={appTab === "pulls"}
          theme={theme}
          icon={
            <GitPullRequest
              size={20}
              color={appTab === "pulls" ? theme.brassText : theme.muted}
            />
          }
          onPress={() => selectBottomTab("pulls")}
        />
        <BottomTabButton
          label="Search"
          active={appTab === "search"}
          theme={theme}
          icon={
            <Search
              size={20}
              color={appTab === "search" ? theme.brassText : theme.muted}
            />
          }
          onPress={() => selectBottomTab("search")}
        />
        <BottomTabButton
          label="Profile"
          active={appTab === "profile"}
          theme={theme}
          icon={
            <UserRound
              size={20}
              color={appTab === "profile" ? theme.brassText : theme.muted}
            />
          }
          onPress={() => selectBottomTab("profile")}
        />
      </View>

      {/* Spotlight Stage Floating Carousel */}
      {openConversationId && openCarouselCards.length > 0 && (
        <SpotlightCarousel
          key={openConversationId}
          cards={openCarouselCards}
          client={client}
          snippets={snippets}
          theme={theme}
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
          onMarkRead={handleMarkRead}
          onToggleSaved={handleToggleSaved}
          onRemind={(card) => setRemindCard(card)}
          onDismissCard={handleDismissCard}
          onSendReply={handleCarouselReply}
        />
      )}

      {/* Full Chronological Thread Sheet */}
      {threadOverlay && (
        <ThreadSheet
          conversationId={threadOverlay.conversationId}
          title={threadOverlay.title}
          agentName={threadOverlay.agentName}
          agentId={threadOverlay.agentId}
          client={client}
          fallbackCards={activeCards.filter(
            (c) => c.conversationId === threadOverlay.conversationId,
          )}
          theme={theme}
          onClose={() => setThreadOverlay(null)}
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
              });
              showToast(
                input.attachmentIds?.length
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
          client={client}
          folders={folders}
          activeRuns={effectiveActiveRuns}
          allCards={activeCards}
          theme={theme}
          onClose={() => setProfileAgent(null)}
          onMessageAgent={(agent) => {
            setProfileAgent(null);
            setComposeAgentId(agent.id);
            setComposeFolderId(agent.folder_id ?? null);
            setComposeOpen(true);
          }}
          onOpenStack={(conversationId) => {
            setProfileAgent(null);
            setCarouselOverrideCards(null);
            setOpenConversationId(conversationId);
          }}
          onOpenThread={(conv) => {
            setProfileAgent(null);
            setThreadOverlay(conv);
          }}
        />
      )}

      {/* New Task / Compose Sheet */}
      {composeOpen && (
        <ComposeSheet
          theme={theme}
          client={client}
          agents={agents}
          folders={folders}
          snippets={snippets}
          defaultAgentId={composeAgentId}
          defaultFolderId={composeFolderId}
          onClose={() => setComposeOpen(false)}
          onSend={handleComposeSend}
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
          onPaired={(nextSession) => {
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
        <View pointerEvents="box-none" style={styles.toastWrap}>
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
  icon,
  theme,
  onPress,
}: {
  label: string;
  active: boolean;
  badge?: number;
  icon: React.ReactNode;
  theme: typeof DARK_THEME;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tabBtn}>
      <View style={styles.tabIconWrap}>
        {icon}
        {!!badge && badge > 0 && (
          <View
            style={[
              styles.tabBarBadge,
              { backgroundColor: theme.brass, borderColor: theme.bg },
            ]}
          >
            <Text style={[styles.tabBarBadgeText, { color: theme.onBrass }]}>
              {badge > 9 ? "9+" : badge}
            </Text>
          </View>
        )}
      </View>
      <Text
        style={[
          styles.tabBtnLabel,
          { color: active ? theme.brassText : theme.muted },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fab: {
    position: "absolute",
    right: 18,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.36,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    zIndex: 18,
  },
  tabBarOuter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    zIndex: 15,
  },
  tabBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 2,
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
    fontSize: 10.5,
    fontWeight: "600",
  },
  toastWrap: {
    position: "absolute",
    bottom: 102,
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
