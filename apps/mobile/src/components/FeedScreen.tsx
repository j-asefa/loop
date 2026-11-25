import React, { useMemo } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import {
  AlertTriangle,
  Bookmark,
  BookmarkCheck,
  Check,
  Layers,
  Link2,
  ShieldAlert,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  resolveCarouselCardHeader,
  stackDoneCards,
  type StackedCardEntry,
} from "../../../../src/shared/done-stack";
import type { SocketStatus } from "../api/socket";
import type {
  ApiApproval,
  ApiNativeDecision,
  ApiFeedSummary,
} from "../api/types";
import { relativeTime, type FeedTab, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { AgentAvatar, feedPreviewText } from "./RichContent";

const TABS: Array<{ id: FeedTab; label: string }> = [
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "replies", label: "Replies" },
];

const SWIPE_THRESHOLD = 82;

type FeedScreenProps = {
  cards: NativeResultCard[];
  activeTab: FeedTab;
  summary?: ApiFeedSummary | null;
  approvals: ApiApproval[];
  decisions: ApiNativeDecision[];
  isLive: boolean;
  environmentName?: string;
  socketStatus: SocketStatus;
  refreshing: boolean;
  theme: LoopTheme;
  scrollRef?: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  onRefresh: () => void;
  onSelectTab: (tab: FeedTab) => void;
  onOpenPairing: () => void;
  onOpenStack: (conversationId: string, cards: NativeResultCard[]) => void;
  onSwipeDone: (card: NativeResultCard) => void;
  onSwipeSave: (card: NativeResultCard) => void;
  onDecideApproval: (id: string, decision: "approve" | "reject") => void;
  onAnswerDecision: (id: string, answer: Record<string, unknown>) => void;
};

export function FeedScreen({
  cards,
  activeTab,
  summary,
  approvals,
  decisions,
  isLive,
  environmentName,
  socketStatus,
  refreshing,
  theme,
  scrollRef,
  onRefresh,
  onSelectTab,
  onOpenPairing,
  onOpenStack,
  onSwipeDone,
  onSwipeSave,
  onDecideApproval,
  onAnswerDecision,
}: FeedScreenProps) {
  const insets = useSafeAreaInsets();

  const tabCounts = useMemo(() => {
    if (isLive && summary) {
      return {
        done: summary.done_unread ?? 0,
        working: summary.working ?? 0,
        queued: summary.queued ?? 0,
        replies: summary.replies_unread ?? 0,
      };
    }
    const counts: Record<FeedTab, number> = {
      done: 0,
      working: 0,
      queued: 0,
      replies: 0,
    };
    const doneConvs = new Set<string>();
    for (const c of cards) {
      if (c.tab === "done") {
        if (!doneConvs.has(c.conversationId)) {
          doneConvs.add(c.conversationId);
          counts.done += 1;
        }
      } else {
        counts[c.tab] += 1;
      }
    }
    return counts;
  }, [cards, isLive, summary]);

  const stacks = useMemo<StackedCardEntry<NativeResultCard>[]>(() => {
    const visible = cards.filter((c) => c.tab === activeTab);
    if (activeTab !== "done") {
      return visible.map((item) => ({
        key: item.id,
        top: item,
        cards: [item],
        unreadCount: item.unread ? 1 : 0,
        isManualGroup: false,
      }));
    }
    return stackDoneCards(
      visible.map((item) => ({
        key: item.id,
        item,
        isManualGroup: false,
        conversationKey: item.conversationId,
        unread: item.unread,
      })),
    );
  }, [cards, activeTab]);

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.state === "pending"),
    [approvals],
  );
  const pendingDecisions = useMemo(
    () => decisions.filter((d) => d.state === "pending"),
    [decisions],
  );
  const needsTotal = pendingApprovals.length + pendingDecisions.length;

  const liveColor =
    socketStatus === "live"
      ? theme.green
      : socketStatus === "connecting" || socketStatus === "reconnecting"
        ? theme.brass
        : theme.muted;

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      {/* Top App Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: Math.max(insets.top + 8, 18),
            borderBottomColor: theme.line,
          },
        ]}
      >
        <View style={styles.brandRow}>
          <View style={styles.brandLeft}>
            <View
              style={[
                styles.logoMark,
                { borderColor: theme.brass, backgroundColor: theme.attention },
              ]}
            >
              <View
                style={[styles.logoDot, { backgroundColor: theme.brass }]}
              />
            </View>
            <Text style={[styles.brandTitle, { color: theme.text }]}>Loop</Text>
          </View>

          <Pressable
            onPress={() => {
              haptics.light();
              onOpenPairing();
            }}
            style={({ pressed }) => [
              styles.connPill,
              {
                backgroundColor: isLive ? theme.surface : theme.attention,
                borderColor: isLive ? theme.line : theme.attentionLine,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            {isLive ? (
              <>
                <View
                  style={[styles.liveDot, { backgroundColor: liveColor }]}
                />
                <Text
                  style={[styles.connPillText, { color: theme.text }]}
                  numberOfLines={1}
                >
                  {environmentName || "Connected"}
                </Text>
              </>
            ) : (
              <>
                <Link2 size={13} color={theme.brassText} />
                <Text style={[styles.connPillText, { color: theme.brassText }]}>
                  Pair live workspace
                </Text>
              </>
            )}
          </Pressable>
        </View>

        {/* Merged 4-Tab Bar (Threads merged into Done) */}
        <View style={styles.tabRow}>
          {TABS.map((tab) => {
            const active = tab.id === activeTab;
            const count = tabCounts[tab.id];
            return (
              <Pressable
                key={tab.id}
                onPress={() => {
                  if (!active) haptics.selection();
                  onSelectTab(tab.id);
                }}
                style={[
                  styles.tabChip,
                  active && {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                  !active && {
                    backgroundColor: "transparent",
                    borderColor: "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.tabLabel,
                    { color: active ? theme.brassText : theme.muted },
                  ]}
                >
                  {tab.label}
                </Text>
                {count > 0 && (
                  <View
                    style={[
                      styles.tabBadge,
                      {
                        backgroundColor: active ? theme.brass : theme.raised,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.tabBadgeText,
                        { color: active ? theme.onBrass : theme.muted },
                      ]}
                    >
                      {count > 9 ? "9+" : count}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Feed List */}
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.brass}
          />
        }
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Math.max(insets.bottom + 104, 120) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Actionable Needs You Stack (only shown when approvals or decisions wait) */}
        {needsTotal > 0 && (
          <View style={styles.needsSection}>
            <View style={styles.needsHead}>
              <ShieldAlert size={14} color={theme.orange} />
              <Text style={[styles.needsLabel, { color: theme.orange }]}>
                NEEDS YOU · {needsTotal}
              </Text>
            </View>

            {pendingApprovals.slice(0, 2).map((app) => (
              <View
                key={app.id}
                style={[
                  styles.needsCard,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.orange,
                  },
                ]}
              >
                <View style={styles.cardMetaRow}>
                  <Text style={[styles.needsAgent, { color: theme.text }]}>
                    @{app.agent_name || "agent"} · {app.tool_name}
                  </Text>
                  <Text style={[styles.cardTime, { color: theme.muted }]}>
                    {relativeTime(app.created_at)}
                  </Text>
                </View>
                <Text
                  style={[styles.needsBody, { color: theme.muted }]}
                  numberOfLines={3}
                >
                  {app.summary || app.arguments || "Approval requested"}
                </Text>
                <View style={styles.needsBtnRow}>
                  <Pressable
                    onPress={() => {
                      haptics.success();
                      onDecideApproval(app.id, "approve");
                    }}
                    style={[
                      styles.needsApproveBtn,
                      { backgroundColor: theme.brass },
                    ]}
                  >
                    <Check size={14} color={theme.onBrass} />
                    <Text
                      style={[
                        styles.needsApproveText,
                        { color: theme.onBrass },
                      ]}
                    >
                      Approve
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      haptics.warning();
                      onDecideApproval(app.id, "reject");
                    }}
                    style={[
                      styles.needsDenyBtn,
                      { backgroundColor: theme.soft, borderColor: theme.line },
                    ]}
                  >
                    <X size={14} color={theme.text} />
                    <Text style={[styles.needsDenyText, { color: theme.text }]}>
                      Deny
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}

            {pendingDecisions.slice(0, 2).map((dec) => (
              <View
                key={dec.id}
                style={[
                  styles.needsCard,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <View style={styles.cardMetaRow}>
                  <View style={styles.rowLeft}>
                    <AlertTriangle size={14} color={theme.brassText} />
                    <Text style={[styles.needsAgent, { color: theme.text }]}>
                      {dec.title || "Decision needed"}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.needsBody, { color: theme.muted }]}>
                  {dec.question || dec.prompt || "Choose an option to continue"}
                </Text>
                {Array.isArray(dec.options) && dec.options.length > 0 && (
                  <View style={styles.decisionOpts}>
                    {dec.options.map((opt, idx) => (
                      <Pressable
                        key={opt.id || idx}
                        onPress={() => {
                          haptics.success();
                          onAnswerDecision(dec.id, {
                            optionId: opt.id ?? opt.label,
                            label: opt.label,
                          });
                        }}
                        style={[
                          styles.decisionPill,
                          {
                            backgroundColor: theme.attention,
                            borderColor: theme.attentionLine,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.decisionPillText,
                            { color: theme.brassText },
                          ]}
                        >
                          {opt.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {activeTab === "done" && stacks.length > 0 && !isLive && (
          <Text style={[styles.gestureHint, { color: theme.muted }]}>
            Tap a stack for carousel · Swipe right for Done · Swipe left to Save
          </Text>
        )}

        {stacks.length === 0 ? (
          <View
            style={[
              styles.emptyCard,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              All clear in {TABS.find((t) => t.id === activeTab)?.label}
            </Text>
            <Text style={[styles.emptyBody, { color: theme.muted }]}>
              {isLive
                ? "Pull down to refresh or tap + to start a new task."
                : "Tap + to ask an agent or pair your live Loop workspace above."}
            </Text>
          </View>
        ) : (
          stacks.map((entry) => (
            <SwipeableStackCard
              key={entry.key}
              entry={entry}
              theme={theme}
              interactive={activeTab === "done" || activeTab === "replies"}
              onOpen={() => {
                haptics.medium();
                onOpenStack(entry.top.conversationId, entry.cards);
              }}
              onSwipeDone={() => onSwipeDone(entry.top)}
              onSwipeSave={() => onSwipeSave(entry.top)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SwipeableStackCard({
  entry,
  theme,
  interactive,
  onOpen,
  onSwipeDone,
  onSwipeSave,
}: {
  entry: StackedCardEntry<NativeResultCard>;
  theme: LoopTheme;
  interactive: boolean;
  onOpen: () => void;
  onSwipeDone: () => void;
  onSwipeSave: () => void;
}) {
  const item = entry.top;
  const stackCount = entry.cards.length;
  const header = useMemo(
    () =>
      resolveCarouselCardHeader({
        prompt: item.prompt,
        body: item.body,
        fallback: item.fallbackTitle,
      }),
    [item.prompt, item.body, item.fallbackTitle],
  );
  const preview = useMemo(() => feedPreviewText(item.body), [item.body]);

  const translateX = useSharedValue(0);
  const pressScale = useSharedValue(1);
  const crossedThreshold = useSharedValue<0 | 1 | -1>(0);

  const fireTick = () => haptics.light();
  const fireDone = () => {
    haptics.success();
    onSwipeDone();
  };
  const fireSave = () => {
    haptics.medium();
    onSwipeSave();
  };

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(interactive)
        .activeOffsetX([-16, 16])
        .failOffsetY([-12, 12])
        .onUpdate((e) => {
          const raw = e.translationX;
          const clamped =
            Math.abs(raw) <= 115
              ? raw
              : Math.sign(raw) * (115 + (Math.abs(raw) - 115) * 0.28);
          translateX.value = clamped;

          const dir: 0 | 1 | -1 =
            clamped >= SWIPE_THRESHOLD
              ? 1
              : clamped <= -SWIPE_THRESHOLD
                ? -1
                : 0;
          if (dir !== crossedThreshold.value) {
            crossedThreshold.value = dir;
            if (dir !== 0) runOnJS(fireTick)();
          }
        })
        .onEnd(() => {
          const finalDir = crossedThreshold.value;
          crossedThreshold.value = 0;
          translateX.value = withSpring(0, {
            damping: 20,
            stiffness: 260,
            mass: 0.85,
          });
          if (finalDir === 1) {
            runOnJS(fireDone)();
          } else if (finalDir === -1) {
            runOnJS(fireSave)();
          }
        })
        .onFinalize(() => {
          crossedThreshold.value = 0;
          translateX.value = withSpring(0, { damping: 22, stiffness: 280 });
        }),
    [interactive, item.id],
  );

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { scale: pressScale.value }],
  }));

  const rightActionStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [18, SWIPE_THRESHOLD],
      [0, 1],
      "clamp",
    ),
    transform: [
      {
        scale: interpolate(
          translateX.value,
          [18, SWIPE_THRESHOLD],
          [0.84, 1],
          "clamp",
        ),
      },
    ],
  }));

  const leftActionStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [-SWIPE_THRESHOLD, -18],
      [1, 0],
      "clamp",
    ),
    transform: [
      {
        scale: interpolate(
          translateX.value,
          [-SWIPE_THRESHOLD, -18],
          [1, 0.84],
          "clamp",
        ),
      },
    ],
  }));

  const stackDepth = stackCount >= 3 ? 3 : stackCount === 2 ? 2 : 1;

  return (
    <View
      style={[
        styles.stackOuter,
        stackDepth === 3 && { marginBottom: 18 },
        stackDepth === 2 && { marginBottom: 12 },
      ]}
    >
      {interactive && (
        <View style={styles.swipeTrack} pointerEvents="none">
          <Animated.View
            style={[
              styles.swipeBadge,
              {
                backgroundColor: theme.greenSoft,
                borderColor: theme.green,
              },
              rightActionStyle,
            ]}
          >
            <Check size={16} color={theme.green} />
            <Text style={[styles.swipeBadgeText, { color: theme.green }]}>
              Done
            </Text>
          </Animated.View>

          <Animated.View
            style={[
              styles.swipeBadge,
              {
                backgroundColor: theme.attention,
                borderColor: theme.attentionLine,
              },
              leftActionStyle,
            ]}
          >
            {item.saved ? (
              <BookmarkCheck size={16} color={theme.brassText} />
            ) : (
              <Bookmark size={16} color={theme.brassText} />
            )}
            <Text style={[styles.swipeBadgeText, { color: theme.brassText }]}>
              {item.saved ? "Unsave" : "Save"}
            </Text>
          </Animated.View>
        </View>
      )}

      {stackDepth >= 3 && (
        <View
          pointerEvents="none"
          style={[
            styles.stackLayerBack,
            { backgroundColor: theme.surface, borderColor: theme.line },
          ]}
        />
      )}
      {stackDepth >= 2 && (
        <View
          pointerEvents="none"
          style={[
            styles.stackLayerMid,
            { backgroundColor: theme.surface, borderColor: theme.line },
          ]}
        />
      )}

      <GestureDetector gesture={panGesture}>
        <Animated.View style={cardAnimatedStyle}>
          <Pressable
            onPressIn={() => {
              pressScale.value = withSpring(0.978, {
                damping: 20,
                stiffness: 380,
              });
            }}
            onPressOut={() => {
              pressScale.value = withSpring(1, {
                damping: 18,
                stiffness: 320,
              });
            }}
            onPress={onOpen}
            style={[
              styles.feedCard,
              {
                backgroundColor: theme.surface,
                borderColor:
                  entry.unreadCount > 0 ? theme.attentionLine : theme.line,
              },
            ]}
          >
            <View style={styles.cardMetaRow}>
              <View style={styles.cardAgentGroup}>
                <AgentAvatar name={item.agentName} size={26} />
                <Text style={[styles.cardAgentName, { color: theme.text }]}>
                  @{item.agentName}
                </Text>
                <Text style={[styles.cardSep, { color: theme.muted }]}>·</Text>
                <Text
                  style={[styles.cardProject, { color: theme.muted }]}
                  numberOfLines={1}
                >
                  {item.projectName}
                </Text>
              </View>
              <Text style={[styles.cardTime, { color: theme.muted }]}>
                {relativeTime(item.createdAt)}
              </Text>
            </View>

            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {header.title}
            </Text>

            {preview ? (
              <Text
                style={[styles.cardPreview, { color: theme.muted }]}
                numberOfLines={3}
              >
                {preview}
              </Text>
            ) : null}

            <View style={styles.cardFooterRow}>
              {stackCount > 1 && (
                <View
                  style={[
                    styles.stackBadge,
                    {
                      backgroundColor: theme.attention,
                      borderColor: theme.attentionLine,
                    },
                  ]}
                >
                  <Layers size={12} color={theme.brassText} />
                  <Text
                    style={[styles.stackBadgeText, { color: theme.brassText }]}
                  >
                    {stackCount} cards
                  </Text>
                </View>
              )}
              {entry.unreadCount > 0 && (
                <View
                  style={[
                    styles.unreadPill,
                    {
                      backgroundColor: theme.attention,
                      borderColor: theme.attentionLine,
                    },
                  ]}
                >
                  <View
                    style={[styles.unreadDot, { backgroundColor: theme.brass }]}
                  />
                  <Text style={[styles.unreadText, { color: theme.brassText }]}>
                    {entry.unreadCount === 1
                      ? "New"
                      : `${entry.unreadCount} new`}
                  </Text>
                </View>
              )}
              {item.saved && (
                <View
                  style={[
                    styles.savedPill,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  <BookmarkCheck size={12} color={theme.brassText} />
                  <Text style={[styles.savedText, { color: theme.brassText }]}>
                    Saved
                  </Text>
                </View>
              )}
              {item.statusLabel && (
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor:
                        item.tab === "working"
                          ? theme.blueSoft
                          : item.tab === "replies"
                            ? theme.orangeSoft
                            : theme.soft,
                      borderColor: theme.line,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      {
                        color:
                          item.tab === "working"
                            ? theme.blue
                            : item.tab === "replies"
                              ? theme.orange
                              : theme.muted,
                      },
                    ]}
                  >
                    {item.statusLabel}
                  </Text>
                </View>
              )}
            </View>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  brandLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  logoMark: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  logoDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  connPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "60%",
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  connPillText: {
    fontSize: 12,
    fontWeight: "700",
    flexShrink: 1,
  },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tabChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  tabLabel: {
    fontSize: 13.5,
    fontWeight: "600",
  },
  tabBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  list: { flex: 1 },
  listContent: {
    padding: 16,
    gap: 14,
  },
  needsSection: {
    gap: 8,
    marginBottom: 4,
  },
  needsHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  needsLabel: {
    fontSize: 11.5,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  needsCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  needsAgent: {
    fontSize: 14,
    fontWeight: "700",
  },
  needsBody: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  needsBtnRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },
  needsApproveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    borderRadius: 12,
  },
  needsApproveText: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  needsDenyBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
  },
  needsDenyText: {
    fontSize: 13.5,
    fontWeight: "600",
  },
  decisionOpts: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
  decisionPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  decisionPillText: {
    fontSize: 13,
    fontWeight: "700",
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  gestureHint: {
    fontSize: 12,
    textAlign: "center",
    marginBottom: 2,
  },
  stackOuter: {
    position: "relative",
    marginBottom: 4,
  },
  swipeTrack: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  swipeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  swipeBadgeText: {
    fontSize: 13,
    fontWeight: "700",
  },
  stackLayerMid: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: -6,
    height: 22,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    borderWidth: 1,
    borderTopWidth: 0,
  },
  stackLayerBack: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: -12,
    height: 22,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    borderWidth: 1,
    borderTopWidth: 0,
    opacity: 0.65,
  },
  feedCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 9,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardAgentGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flex: 1,
    minWidth: 0,
  },
  cardAgentName: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  cardSep: {
    fontSize: 13,
  },
  cardProject: {
    fontSize: 12.5,
    flexShrink: 1,
  },
  cardTime: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  cardTitle: {
    fontSize: 18,
    lineHeight: 23.5,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  cardPreview: {
    fontSize: 14,
    lineHeight: 20,
  },
  cardFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 2,
  },
  stackBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  stackBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  unreadPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  unreadText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  savedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  savedText: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  statusPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  emptyCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 6,
    marginTop: 20,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  emptyBody: {
    fontSize: 13.5,
    textAlign: "center",
    lineHeight: 20,
  },
});
