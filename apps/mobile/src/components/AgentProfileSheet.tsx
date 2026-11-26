import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Cpu,
  Folder,
  Layers,
  Plus,
  Search,
  Terminal,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import type { ApiAgent, ApiFolder } from "../api/types";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import {
  AgentAvatar,
  feedPreviewText,
  ProfileCoverBanner,
} from "./RichContent";

type ProfileTab = "results" | "threads" | "traces";

export type AgentRunSummary = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  input: string;
  state: string;
  created_at: number;
};

export function AgentProfileSheet({
  agent,
  client,
  folders,
  activeRuns,
  allCards,
  theme,
  onClose,
  onMessageAgent,
  onOpenStack,
  onOpenThread,
}: {
  agent: ApiAgent;
  client: LoopClient | null;
  folders: ApiFolder[];
  activeRuns: AgentRunSummary[];
  allCards: NativeResultCard[];
  theme: LoopTheme;
  onClose: () => void;
  onMessageAgent: (agent: ApiAgent) => void;
  onOpenStack: (conversationId: string, seedCard?: NativeResultCard) => void;
  onOpenThread: (input: {
    conversationId: string;
    title: string;
    agentName: string;
    agentId?: string | null;
  }) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<ProfileTab>("results");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [loading, setLoading] = useState(Boolean(client));

  const [conversations, setConversations] = useState<
    Array<{ id: string; title: string; created_at: number }>
  >([]);
  const [agentResults, setAgentResults] = useState<NativeResultCard[]>([]);
  const [traces, setTraces] = useState<
    Array<{
      id: string;
      kind?: string;
      title?: string | null;
      content?: string | null;
      created_at: number;
    }>
  >([]);
  const [traceQuery, setTraceQuery] = useState("");

  const agentRuns = useMemo(
    () =>
      activeRuns.filter(
        (r) =>
          r.agent_id === agent.id &&
          [
            "running",
            "pausing",
            "queued",
            "awaiting_approval",
            "paused",
            "failed",
            "interrupted",
            "waiting_children",
          ].includes(r.state),
      ),
    [activeRuns, agent.id],
  );

  const status = useMemo(() => {
    if (
      agentRuns.some((r) =>
        ["awaiting_approval", "paused", "failed", "interrupted"].includes(
          r.state,
        ),
      )
    )
      return "Needs you";
    if (
      agentRuns.some((r) =>
        ["running", "waiting_children", "pausing"].includes(r.state),
      )
    )
      return "Working";
    if (agentRuns.some((r) => r.state === "queued")) return "Queued";
    return "Ready";
  }, [agentRuns]);

  const statusColor =
    status === "Needs you"
      ? theme.orange
      : status === "Working"
        ? theme.blue
        : status === "Queued"
          ? theme.brass
          : theme.green;

  const projectName = useMemo(() => {
    if (!agent.folder_id) return "Workspace";
    return folders.find((f) => f.id === agent.folder_id)?.name || "Workspace";
  }, [folders, agent.folder_id]);

  const seenFeedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    seenFeedIdsRef.current = new Set();
  }, [client, agent.id]);

  // Demo mode: keep local results synced without re-fetching in live mode
  useEffect(() => {
    if (client) return;
    const mine = allCards.filter(
      (c) =>
        c.agentId === agent.id ||
        c.agentName.toLowerCase() === agent.name.toLowerCase(),
    );
    setAgentResults(mine);
    const seen = new Set<string>();
    setConversations(
      mine
        .filter((c) => {
          if (seen.has(c.conversationId)) return false;
          seen.add(c.conversationId);
          return true;
        })
        .map((c) => ({
          id: c.conversationId,
          title: c.fallbackTitle,
          created_at: c.createdAt,
        })),
    );
    setLoading(false);
  }, [client, agent.id, agent.name, allCards]);

  // Live mode: load once per agent/client without blanking lists on background WS refreshes
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      client.agentDetail(agent.id),
      client.doneCards({ agent: agent.id }).catch(() => null),
      client.feed("done", { agent: agent.id }).catch(() => null),
    ])
      .then(([detail, doneCardItems, feedPage]) => {
        if (cancelled) return;
        setConversations(detail.conversations);
        const sourceItems =
          doneCardItems && doneCardItems.length > 0
            ? doneCardItems
            : (feedPage?.items ?? []);
        setAgentResults(
          sourceItems.map((item) => ({
            id:
              item.done_card_key ??
              item.last_message?.id ??
              `${item.conversation_id}:${item.last_activity_at}`,
            conversationId: item.conversation_id,
            tab: "done",
            agentId: item.agent_id,
            agentName: item.agent_name || agent.name,
            projectName: item.project_name || projectName,
            model: item.run?.resolved_model || item.run?.model || agent.model,
            prompt: item.run?.input || item.title,
            fallbackTitle: item.title,
            body:
              item.last_message?.content ?? item.last_message?.preview ?? "",
            createdAt: item.last_message?.created_at ?? item.last_activity_at,
            saved: Boolean(item.last_message?.saved),
            unread: item.read_at === null,
            doneUnread: item.read_at === null,
            messageId: item.last_message?.id,
            doneCardKey: item.done_card_key,
            unreadVersion: item.unread_version,
          })),
        );
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, agent.id, agent.name, agent.model, projectName]);

  // Overlay live feed updates (unread, saved, new arrivals, dismissals) onto fetched
  // agentResults without re-triggering the loading spinner on every socket refresh.
  const displayedResults = useMemo(() => {
    if (!client) return agentResults;
    const liveMine = allCards.filter(
      (c) =>
        c.agentId === agent.id ||
        c.agentName.toLowerCase() === agent.name.toLowerCase(),
    );
    const liveById = new Map<string, NativeResultCard>();
    const liveByMsg = new Map<string, NativeResultCard>();
    for (const c of liveMine) {
      liveById.set(c.id, c);
      if (c.messageId) liveByMsg.set(c.messageId, c);
      seenFeedIdsRef.current.add(c.id);
    }

    const merged: NativeResultCard[] = [];
    const includedIds = new Set<string>();
    const includedMsgs = new Set<string>();
    for (const card of agentResults) {
      const liveMatch =
        liveById.get(card.id) ??
        (card.messageId ? liveByMsg.get(card.messageId) : undefined);
      if (liveMatch) {
        merged.push(liveMatch);
        includedIds.add(liveMatch.id);
        if (liveMatch.messageId) includedMsgs.add(liveMatch.messageId);
      } else if (!seenFeedIdsRef.current.has(card.id)) {
        // Keep older history cards that were never part of the top-N feed page
        merged.push(card);
        includedIds.add(card.id);
        if (card.messageId) includedMsgs.add(card.messageId);
      }
    }
    for (const c of liveMine) {
      if (includedIds.has(c.id)) continue;
      if (c.messageId && includedMsgs.has(c.messageId)) continue;
      merged.push(c);
    }
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged;
  }, [agent.id, agent.name, agentResults, allCards, client]);

  useEffect(() => {
    if (tab !== "traces" || !client) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .agentTraces(agent.id, traceQuery.trim() || undefined)
        .then((list) => {
          if (!cancelled) setTraces(list);
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, client, agent.id, traceQuery]);

  const cleanModel = (agent.model || "").replace(/^Claude /, "");

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.bg, zIndex: 44 },
      ]}
    >
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom + 36, 48),
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Illustrated Charley-Harper Habitat Cover Banner */}
        <View style={styles.coverWrap}>
          <ProfileCoverBanner
            name={agent.name}
            height={146 + Math.max(insets.top - 20, 0)}
          />
          <Pressable
            accessibilityLabel="Back"
            onPress={() => {
              haptics.light();
              onClose();
            }}
            style={[
              styles.floatingBackBtn,
              {
                top: Math.max(insets.top + 8, 18),
                backgroundColor: "rgba(20, 20, 18, 0.72)",
              },
            ]}
          >
            <ArrowLeft size={18} color="#f5f5f2" />
          </Pressable>
        </View>

        {/* Avatar + Name + Message Action */}
        <View style={styles.identitySection}>
          <View style={styles.avatarRow}>
            <View
              style={[
                styles.avatarHalo,
                { borderColor: theme.bg, backgroundColor: theme.bg },
              ]}
            >
              <AgentAvatar name={agent.name} size={74} />
              <View
                style={[
                  styles.statusDotLg,
                  { backgroundColor: statusColor, borderColor: theme.bg },
                ]}
              />
            </View>

            <Pressable
              accessibilityLabel={`Message @${agent.name}`}
              onPress={() => {
                haptics.medium();
                onMessageAgent(agent);
              }}
              style={({ pressed }) => [
                styles.messageBtn,
                {
                  backgroundColor: theme.brass,
                  transform: [{ scale: pressed ? 0.92 : 1 }],
                },
              ]}
            >
              <Plus size={22} color={theme.onBrass} strokeWidth={2.5} />
            </Pressable>
          </View>

          <View style={styles.nameBlock}>
            <View style={styles.nameRow}>
              <Text style={[styles.agentHandle, { color: theme.text }]}>
                @{agent.name}
              </Text>
              <View
                style={[
                  styles.statusPill,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                  },
                ]}
              >
                <View
                  style={[
                    styles.statusMiniDot,
                    { backgroundColor: statusColor },
                  ]}
                />
                <Text style={[styles.statusPillText, { color: theme.text }]}>
                  {status}
                </Text>
              </View>
            </View>

            <View style={styles.metaChips}>
              {cleanModel ? (
                <View
                  style={[
                    styles.metaChip,
                    { backgroundColor: theme.surface, borderColor: theme.line },
                  ]}
                >
                  <Cpu size={12} color={theme.brassText} />
                  <Text style={[styles.metaChipText, { color: theme.muted }]}>
                    {cleanModel}
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.metaChip,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <Folder size={12} color={theme.muted} />
                <Text style={[styles.metaChipText, { color: theme.muted }]}>
                  {projectName}
                </Text>
              </View>
            </View>
          </View>

          {/* Expandable Instructions */}
          {agent.instructions?.trim() ? (
            <Pressable
              onPress={() => {
                haptics.light();
                setInstructionsOpen((v) => !v);
              }}
              style={[
                styles.instructionsCard,
                { backgroundColor: theme.surface, borderColor: theme.line },
              ]}
            >
              <View style={styles.instructionsHead}>
                <Text style={[styles.sectionLabel, { color: theme.muted }]}>
                  INSTRUCTIONS
                </Text>
                {instructionsOpen ? (
                  <ChevronUp size={15} color={theme.muted} />
                ) : (
                  <ChevronDown size={15} color={theme.muted} />
                )}
              </View>
              <Text
                style={[styles.instructionsText, { color: theme.text }]}
                numberOfLines={instructionsOpen ? undefined : 2}
              >
                {agent.instructions.trim()}
              </Text>
            </Pressable>
          ) : null}

          {/* Current Work */}
          {agentRuns.length > 0 && (
            <View
              style={[
                styles.currentWorkCard,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <Text style={[styles.sectionLabel, { color: theme.brassText }]}>
                CURRENT WORK · {agentRuns.length}
              </Text>
              {agentRuns.slice(0, 3).map((r) => (
                <Pressable
                  key={r.id}
                  onPress={() => {
                    haptics.light();
                    if (r.conversation_id) {
                      onOpenThread({
                        conversationId: r.conversation_id,
                        title: r.input,
                        agentName: agent.name,
                        agentId: agent.id,
                      });
                    }
                  }}
                  style={styles.workRow}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.workState, { color: theme.blue }]}>
                      {r.state.replace(/_/g, " ")}
                    </Text>
                    <Text
                      style={[styles.workInput, { color: theme.text }]}
                      numberOfLines={2}
                    >
                      {r.input}
                    </Text>
                  </View>
                  <ArrowUpRight size={16} color={theme.muted} />
                </Pressable>
              ))}
            </View>
          )}

          {/* Segmented Tabs: Results | Threads | Traces */}
          <View style={[styles.tabsRow, { borderBottomColor: theme.line }]}>
            {(
              [
                {
                  id: "results",
                  label: "Results",
                  count: displayedResults.length,
                },
                {
                  id: "threads",
                  label: "Threads",
                  count: conversations.length,
                },
                { id: "traces", label: "Traces" },
              ] as const
            ).map((t) => {
              const active = t.id === tab;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    haptics.selection();
                    setTab(t.id);
                  }}
                  style={[
                    styles.tabBtn,
                    active && { borderBottomColor: theme.brassText },
                  ]}
                >
                  <Text
                    style={[
                      styles.tabLabel,
                      { color: active ? theme.brassText : theme.muted },
                    ]}
                  >
                    {t.label}
                    {"count" in t && t.count > 0 ? ` · ${t.count}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {loading ? (
            <ActivityIndicator
              color={theme.brassText}
              style={{ marginTop: 24 }}
            />
          ) : tab === "results" ? (
            displayedResults.length === 0 ? (
              <Text style={[styles.emptyHint, { color: theme.muted }]}>
                No completed results from @{agent.name} yet.
              </Text>
            ) : (
              <View style={styles.listGap}>
                {displayedResults.map((card) => (
                  <Pressable
                    key={card.id}
                    onPress={() => {
                      haptics.medium();
                      onOpenStack(card.conversationId, card);
                    }}
                    style={[
                      styles.itemCard,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <View style={styles.itemHead}>
                      <View style={styles.rowLeft}>
                        <Layers size={12} color={theme.brassText} />
                        <Text style={[styles.itemMeta, { color: theme.muted }]}>
                          {card.projectName}
                        </Text>
                      </View>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>
                        {relativeTime(card.createdAt)}
                      </Text>
                    </View>
                    <Text style={[styles.itemTitle, { color: theme.text }]}>
                      {card.fallbackTitle}
                    </Text>
                    <Text
                      style={[styles.itemPreview, { color: theme.muted }]}
                      numberOfLines={2}
                    >
                      {feedPreviewText(card.body)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )
          ) : tab === "threads" ? (
            conversations.length === 0 ? (
              <Text style={[styles.emptyHint, { color: theme.muted }]}>
                No conversations yet.
              </Text>
            ) : (
              <View style={styles.listGap}>
                {conversations.map((conv) => (
                  <Pressable
                    key={conv.id}
                    onPress={() => {
                      haptics.light();
                      onOpenThread({
                        conversationId: conv.id,
                        title: conv.title,
                        agentName: agent.name,
                        agentId: agent.id,
                      });
                    }}
                    style={[
                      styles.itemCard,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <View style={styles.itemHead}>
                      <Text
                        style={[
                          styles.itemTitle,
                          { color: theme.text, flex: 1 },
                        ]}
                      >
                        {conv.title}
                      </Text>
                      <ArrowUpRight size={15} color={theme.muted} />
                    </View>
                    <Text style={[styles.itemMeta, { color: theme.muted }]}>
                      Started {relativeTime(conv.created_at)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )
          ) : (
            <View style={styles.listGap}>
              <View
                style={[
                  styles.traceSearch,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <Search size={15} color={theme.muted} />
                <TextInput
                  value={traceQuery}
                  onChangeText={setTraceQuery}
                  placeholder={`Search @${agent.name}'s tool traces…`}
                  placeholderTextColor={theme.muted}
                  style={[styles.traceInput, { color: theme.text }]}
                  autoCorrect={false}
                />
              </View>
              {!client ? (
                <Text style={[styles.emptyHint, { color: theme.muted }]}>
                  Pair a live workspace to inspect tool traces for @{agent.name}
                  .
                </Text>
              ) : traces.length === 0 ? (
                <Text style={[styles.emptyHint, { color: theme.muted }]}>
                  No traces recorded yet.
                </Text>
              ) : (
                traces.map((tr) => (
                  <View
                    key={tr.id}
                    style={[
                      styles.itemCard,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <View style={styles.itemHead}>
                      <View style={styles.rowLeft}>
                        <Terminal size={13} color={theme.brassText} />
                        <Text
                          style={[
                            styles.itemMeta,
                            { color: theme.brassText, fontWeight: "700" },
                          ]}
                        >
                          {tr.title || tr.kind || "Activity"}
                        </Text>
                      </View>
                      <Text style={[styles.itemMeta, { color: theme.muted }]}>
                        {relativeTime(tr.created_at)}
                      </Text>
                    </View>
                    {tr.content ? (
                      <Text
                        style={[styles.traceBody, { color: theme.muted }]}
                        numberOfLines={4}
                      >
                        {tr.content}
                      </Text>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  coverWrap: {
    position: "relative",
  },
  floatingBackBtn: {
    position: "absolute",
    left: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  identitySection: {
    paddingHorizontal: 16,
    gap: 14,
  },
  avatarRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginTop: -37,
  },
  avatarHalo: {
    borderRadius: 42,
    borderWidth: 4,
    position: "relative",
  },
  statusDotLg: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
  },
  messageBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  nameBlock: {
    gap: 8,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  agentHandle: {
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusMiniDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusPillText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  metaChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  metaChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  instructionsCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 13,
    gap: 6,
  },
  instructionsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionLabel: {
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  instructionsText: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  currentWorkCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 13,
    gap: 10,
  },
  workRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  workState: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  workInput: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  tabsRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabLabel: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  listGap: {
    gap: 10,
  },
  itemCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  itemHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  itemMeta: {
    fontSize: 12,
  },
  itemTitle: {
    fontSize: 15.5,
    fontWeight: "700",
    lineHeight: 21,
  },
  itemPreview: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  traceSearch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
  },
  traceInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  traceBody: {
    fontFamily: "Courier",
    fontSize: 12,
    lineHeight: 17,
  },
  emptyHint: {
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 28,
    lineHeight: 20,
  },
});
