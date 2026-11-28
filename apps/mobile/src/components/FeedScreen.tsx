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
  Bookmark,
  BookmarkCheck,
  Check,
  Layers,
  Link2,
  Plus,
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
  ApiAgent,
  ApiApproval,
  ApiConnection,
  ApiNativeDecision,
} from "../api/types";
import { agentModelLabel } from "../models";
import type { AgentRunSummary } from "./AgentProfileSheet";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import { NativeDecisionCard } from "./NativeDecisionCard";
import type { LoopTheme } from "../theme";
import {
  AgentAvatar,
  feedPreviewText,
  InlineFormattedText,
} from "./RichContent";

const SWIPE_THRESHOLD = 82;

type FeedScreenProps = {
  cards: NativeResultCard[];
  agents: ApiAgent[];
  connections: ApiConnection[];
  activeRuns: AgentRunSummary[];
  approvals: ApiApproval[];
  decisions: ApiNativeDecision[];
  isLive: boolean;
  environmentName?: string;
  socketStatus: SocketStatus;
  showingCached?: boolean;
  cachedAt?: number | null;
  refreshing: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  theme: LoopTheme;
  scrollRef?: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onOpenPairing: () => void;
  onOpenAgent: (agent: ApiAgent, workingRun?: AgentRunSummary) => void;
  onOpenAgentByName: (
    agentId: string | null | undefined,
    agentName: string,
  ) => void;
  onNewAgent: () => void;
  onOpenStack: (conversationId: string, cards: NativeResultCard[]) => void;
  onSwipeDone: (card: NativeResultCard) => void;
  onSwipeSave: (card: NativeResultCard) => void;
  onDecideApproval: (id: string, decision: "approve" | "reject") => void;
  onAnswerDecision: (id: string, answer: Record<string, unknown>) => void;
  onOpenDecisionThread: (conversationId: string, agentName: string) => void;
};

const WORKING_STATES = new Set(["running", "pausing", "waiting_children"]);
const NEEDS_STATES = new Set([
  "failed",
  "interrupted",
  "awaiting_approval",
  "paused",
]);

export function FeedScreen({
  cards,
  agents,
  connections,
  activeRuns,
  approvals,
  decisions,
  isLive,
  environmentName,
  socketStatus,
  showingCached = false,
  cachedAt = null,
  refreshing,
  hasMore = false,
  loadingMore = false,
  theme,
  scrollRef,
  onRefresh,
  onLoadMore,
  onOpenPairing,
  onOpenAgent,
  onOpenAgentByName,
  onNewAgent,
  onOpenStack,
  onSwipeDone,
  onSwipeSave,
  onDecideApproval,
  onAnswerDecision,
  onOpenDecisionThread,
}: FeedScreenProps) {
  const insets = useSafeAreaInsets();

  // Unified Feed: Done results + Replies stacked by conversation, newest first
  const stacks = useMemo<StackedCardEntry<NativeResultCard>[]>(() => {
    const visible = cards
      .filter((c) => c.tab === "done" || c.tab === "replies")
      .sort((a, b) => b.createdAt - a.createdAt);
    return stackDoneCards(
      visible.map((item) => ({
        key: item.id,
        item,
        isManualGroup: false,
        conversationKey: item.conversationId,
        unread: item.unread,
      })),
    );
  }, [cards]);

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.state === "pending"),
    [approvals],
  );
  const pendingDecisions = useMemo(
    () => decisions.filter((d) => d.state === "pending"),
    [decisions],
  );
  const needsTotal = pendingApprovals.length + pendingDecisions.length;

  const orderedAgents = useMemo(() => {
    const active = agents.filter((a) => !a.retired_at);
    return active
      .map((agent, index) => {
        const myRuns = activeRuns.filter((r) => r.agent_id === agent.id);
        const workingRuns = myRuns
          .filter((r) => WORKING_STATES.has(r.state))
          .sort((a, b) => {
            const aConv = a.conversation_id ? 1 : 0;
            const bConv = b.conversation_id ? 1 : 0;
            if (aConv !== bConv) return bConv - aConv;
            return b.created_at - a.created_at;
          });
        const queuedRuns = myRuns.filter((r) => r.state === "queued");
        const workingRun = workingRuns[0];
        const workingAt = workingRun ? workingRun.created_at : null;
        const queuedCount = queuedRuns.length;
        const status = myRuns.some((r) => NEEDS_STATES.has(r.state))
          ? ("Needs you" as const)
          : workingAt !== null
            ? ("Working" as const)
            : queuedCount > 0
              ? ("Queued" as const)
              : ("Ready" as const);
        return { agent, index, workingAt, workingRun, queuedCount, status };
      })
      .sort((a, b) => {
        if (a.workingAt !== null && b.workingAt !== null) {
          return b.workingAt - a.workingAt;
        }
        if (a.workingAt !== null) return -1;
        if (b.workingAt !== null) return 1;
        if (a.queuedCount !== b.queuedCount)
          return b.queuedCount - a.queuedCount;
        return a.index - b.index;
      });
  }, [agents, activeRuns]);

  const liveColor =
    socketStatus === "live"
      ? theme.green
      : socketStatus === "connecting" || socketStatus === "reconnecting"
        ? theme.brassText
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
                {
                  borderColor: theme.isDark ? theme.brass : theme.text,
                  backgroundColor: theme.isDark ? theme.attention : theme.brass,
                },
              ]}
            >
              <View
                style={[
                  styles.logoDot,
                  {
                    backgroundColor: theme.isDark ? theme.brass : theme.onBrass,
                  },
                ]}
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
      </View>

      {/* Offline Cached Snapshot Indicator */}
      {isLive && showingCached && socketStatus === "offline" && (
        <View
          style={[
            styles.cachedBanner,
            {
              backgroundColor: theme.attention,
              borderBottomColor: theme.attentionLine,
            },
          ]}
        >
          <Text
            style={[styles.cachedBannerText, { color: theme.brassText }]}
            numberOfLines={1}
          >
            Offline · showing cached feed
            {cachedAt ? ` · ${relativeTime(cachedAt)}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry live connection"
            onPress={() => {
              haptics.light();
              onRefresh();
            }}
            style={[
              styles.cachedRetryBtn,
              {
                backgroundColor: theme.surface,
                borderColor: theme.attentionLine,
              },
            ]}
          >
            <Text style={[styles.cachedRetryText, { color: theme.text }]}>
              Retry
            </Text>
          </Pressable>
        </View>
      )}

      {/* Feed List */}
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.brassText}
          />
        }
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Math.max(insets.bottom + 104, 120) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Your Agents Horizontal Shortcut Strip (Loop's signature agent header) */}
        <View style={styles.agentsStripSection}>
          <Text style={[styles.agentsStripTitle, { color: theme.muted }]}>
            YOUR AGENTS
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.agentsStripRow}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New agent"
              onPress={() => {
                haptics.light();
                onNewAgent();
              }}
              style={({ pressed }) => [
                styles.agentShortcut,
                { transform: [{ scale: pressed ? 0.94 : 1 }] },
              ]}
            >
              <Text style={styles.shortcutModel}> </Text>
              <View
                style={[
                  styles.newAgentPortrait,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                  },
                ]}
              >
                <Plus size={22} color={theme.brassText} />
              </View>
            </Pressable>

            {orderedAgents.map(({ agent, status, workingRun, queuedCount }) => {
              const queuedIndicatorColor = theme.isDark
                ? theme.brass
                : theme.brassText;
              const dotColor =
                status === "Needs you"
                  ? theme.orange
                  : status === "Working"
                    ? theme.blue
                    : status === "Queued"
                      ? queuedIndicatorColor
                      : theme.green;
              const shortModel = agentModelLabel(agent, connections).replace(
                /^Claude /,
                "",
              );
              const statusCaption =
                status === "Working" && queuedCount > 0
                  ? `Working · ${queuedCount}q`
                  : status === "Queued"
                    ? `${queuedCount} queued`
                    : status;
              return (
                <Pressable
                  key={agent.id}
                  onPress={() => {
                    if (status === "Working" && workingRun) {
                      haptics.medium();
                      onOpenAgent(agent, workingRun);
                    } else {
                      haptics.light();
                      onOpenAgent(agent);
                    }
                  }}
                  style={({ pressed }) => [
                    styles.agentShortcut,
                    { transform: [{ scale: pressed ? 0.94 : 1 }] },
                  ]}
                >
                  <Text
                    style={[styles.shortcutModel, { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {shortModel || " "}
                  </Text>
                  <View
                    style={[
                      styles.agentPortraitRing,
                      {
                        padding: status === "Working" ? 1.5 : 2.5,
                        borderWidth: status === "Working" ? 2.5 : 1.5,
                        backgroundColor:
                          status === "Working" ? theme.blueSoft : "transparent",
                        borderColor:
                          status === "Working"
                            ? theme.blue
                            : status === "Needs you"
                              ? theme.orange
                              : queuedCount > 0
                                ? queuedIndicatorColor
                                : theme.line,
                      },
                    ]}
                  >
                    <AgentAvatar name={agent.name} size={52} />
                    {queuedCount > 0 && (
                      <View
                        style={[
                          styles.agentQueuedBadge,
                          {
                            backgroundColor: theme.brass,
                            borderColor: theme.bg,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.agentQueuedBadgeText,
                            { color: theme.onBrass },
                          ]}
                        >
                          +{queuedCount > 9 ? "9" : queuedCount}
                        </Text>
                      </View>
                    )}
                    <View
                      style={[
                        styles.agentPortraitDot,
                        {
                          backgroundColor: dotColor,
                          borderColor: theme.bg,
                        },
                      ]}
                    />
                  </View>
                  <Text
                    style={[styles.shortcutName, { color: theme.text }]}
                    numberOfLines={1}
                  >
                    @{agent.name}
                  </Text>
                  {status === "Working" ? (
                    <View
                      style={[
                        styles.workingStatusPill,
                        { backgroundColor: theme.blue },
                      ]}
                    >
                      <Text
                        style={[
                          styles.workingStatusText,
                          { color: theme.onBlue },
                        ]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.82}
                      >
                        {statusCaption}
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.shortcutStatus,
                        {
                          color: status === "Ready" ? theme.muted : dotColor,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {statusCaption}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

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
                      { backgroundColor: theme.green },
                    ]}
                  >
                    <Check size={14} color={theme.onGreen} />
                    <Text
                      style={[
                        styles.needsApproveText,
                        { color: theme.onGreen },
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
              <NativeDecisionCard
                key={dec.id}
                decision={dec}
                theme={theme}
                onAnswer={onAnswerDecision}
                onOpenThread={onOpenDecisionThread}
              />
            ))}
          </View>
        )}

        {stacks.length > 0 && !isLive && (
          <Text style={[styles.gestureHint, { color: theme.muted }]}>
            Tap a stack for carousel · Swipe left for Done · Swipe right to Save
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
              All clear
            </Text>
            <Text style={[styles.emptyBody, { color: theme.muted }]}>
              {isLive
                ? "Pull down to refresh or tap + to start a new agent."
                : "Tap + to ask an agent or pair your live Loop workspace above."}
            </Text>
          </View>
        ) : (
          stacks.map((entry) => (
            <SwipeableStackCard
              key={entry.key}
              entry={entry}
              theme={theme}
              interactive
              onOpen={() => {
                haptics.medium();
                onOpenStack(entry.top.conversationId, entry.cards);
              }}
              onOpenAgent={() => {
                haptics.light();
                onOpenAgentByName(entry.top.agentId, entry.top.agentName);
              }}
              onSwipeDone={() => onSwipeDone(entry.top)}
              onSwipeSave={() => onSwipeSave(entry.top)}
            />
          ))
        )}

        {hasMore && onLoadMore && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Load older cards"
            disabled={loadingMore}
            onPress={() => {
              haptics.light();
              onLoadMore();
            }}
            style={({ pressed }) => [
              styles.loadMoreBtn,
              {
                backgroundColor: pressed ? theme.attention : theme.surface,
                borderColor: theme.line,
                opacity: loadingMore ? 0.65 : 1,
              },
            ]}
          >
            <Text style={[styles.loadMoreText, { color: theme.text }]}>
              {loadingMore ? "Loading older cards…" : "Load older cards"}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const SwipeableStackCard = React.memo(function SwipeableStackCard({
  entry,
  theme,
  interactive,
  onOpen,
  onOpenAgent,
  onSwipeDone,
  onSwipeSave,
}: {
  entry: StackedCardEntry<NativeResultCard>;
  theme: LoopTheme;
  interactive: boolean;
  onOpen: () => void;
  onOpenAgent: () => void;
  onSwipeDone: () => void;
  onSwipeSave: () => void;
}) {
  const item = entry.top;
  const stackCount = entry.cards.length;
  const header = useMemo(
    () =>
      resolveCarouselCardHeader({
        prompt: item.prompt,
        body: item.body.slice(0, 400),
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
            runOnJS(fireSave)();
          } else if (finalDir === -1) {
            runOnJS(fireDone)();
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
                backgroundColor: theme.attention,
                borderColor: theme.attentionLine,
              },
              rightActionStyle,
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

          <Animated.View
            style={[
              styles.swipeBadge,
              {
                backgroundColor: theme.greenSoft,
                borderColor: theme.green,
              },
              leftActionStyle,
            ]}
          >
            <Check size={16} color={theme.green} />
            <Text style={[styles.swipeBadgeText, { color: theme.green }]}>
              Done
            </Text>
          </Animated.View>
        </View>
      )}

      {stackDepth >= 3 && (
        <View
          pointerEvents="none"
          style={[
            styles.stackLayerBack,
            {
              backgroundColor:
                entry.unreadCount > 0 ? theme.unreadSurface : theme.surface,
              borderColor:
                entry.unreadCount > 0 ? theme.unreadLine : theme.line,
            },
          ]}
        />
      )}
      {stackDepth >= 2 && (
        <View
          pointerEvents="none"
          style={[
            styles.stackLayerMid,
            {
              backgroundColor:
                entry.unreadCount > 0 ? theme.unreadSurface : theme.surface,
              borderColor:
                entry.unreadCount > 0 ? theme.unreadLine : theme.line,
            },
          ]}
        />
      )}

      <GestureDetector gesture={panGesture}>
        <Animated.View style={cardAnimatedStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${entry.unreadCount > 0 ? `${entry.unreadCount} unread, ` : ""}@${item.agentName}, ${header.title}${stackCount > 1 ? `, ${stackCount} cards` : ""}`}
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
                backgroundColor:
                  entry.unreadCount > 0 ? theme.unreadSurface : theme.surface,
                borderColor:
                  entry.unreadCount > 0 ? theme.unreadLine : theme.line,
                borderWidth: entry.unreadCount > 0 ? 1.5 : 1,
              },
            ]}
          >
            <View style={styles.cardMetaRow}>
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  onOpenAgent();
                }}
                hitSlop={6}
                style={styles.cardAgentGroup}
              >
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
              </Pressable>
              <View style={styles.cardMetaRight}>
                <Text style={[styles.cardTime, { color: theme.muted }]}>
                  {relativeTime(item.createdAt)}
                </Text>
              </View>
            </View>

            <InlineFormattedText
              text={header.title}
              theme={theme}
              baseStyle={styles.cardTitle}
            />

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
                      backgroundColor: theme.purpleSoft,
                      borderColor: theme.purple,
                    },
                  ]}
                >
                  <Layers size={12} color={theme.purple} />
                  <Text
                    style={[styles.stackBadgeText, { color: theme.purple }]}
                  >
                    {stackCount} cards
                  </Text>
                </View>
              )}
              {item.saved && (
                <View
                  style={[
                    styles.savedPill,
                    {
                      backgroundColor: theme.roseSoft,
                      borderColor: theme.rose,
                    },
                  ]}
                >
                  <BookmarkCheck size={12} color={theme.rose} />
                  <Text style={[styles.savedText, { color: theme.rose }]}>
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
                        item.tab === "working" || item.tab === "replies"
                          ? theme.blueSoft
                          : theme.soft,
                      borderColor:
                        item.tab === "working" || item.tab === "replies"
                          ? theme.blue
                          : theme.line,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      {
                        color:
                          item.tab === "working" || item.tab === "replies"
                            ? theme.blue
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
});

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
  agentsStripSection: {
    gap: 8,
    marginHorizontal: -16,
    marginBottom: 2,
  },
  agentsStripTitle: {
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 0.7,
    paddingHorizontal: 16,
  },
  agentsStripRow: {
    paddingHorizontal: 16,
    gap: 14,
  },
  agentShortcut: {
    width: 72,
    alignItems: "center",
    gap: 3,
  },
  shortcutModel: {
    fontSize: 9.5,
    fontWeight: "600",
    height: 13,
    textAlign: "center",
  },
  newAgentPortrait: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  agentPortraitRing: {
    padding: 2,
    borderRadius: 30,
    borderWidth: 1.5,
    position: "relative",
    marginBottom: 2,
  },
  agentQueuedBadge: {
    position: "absolute",
    top: -4,
    right: -6,
    minWidth: 20,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  agentQueuedBadgeText: {
    fontSize: 9.5,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  agentPortraitDot: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    borderWidth: 2.5,
  },
  shortcutName: {
    fontSize: 12.5,
    fontWeight: "700",
    textAlign: "center",
  },
  shortcutStatus: {
    fontSize: 10.5,
    fontWeight: "600",
    textAlign: "center",
  },
  workingStatusPill: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 999,
    maxWidth: 72,
  },
  workingStatusText: {
    fontSize: 9.5,
    fontWeight: "800",
    textAlign: "center",
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
  cardMetaRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flexShrink: 0,
  },
  cardTime: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  cardTitle: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  cardPreview: {
    fontSize: 15.5,
    lineHeight: 22,
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
  loadMoreBtn: {
    marginTop: 6,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadMoreText: {
    fontSize: 14,
    fontWeight: "600",
  },
  cachedBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  cachedBannerText: {
    fontSize: 12.5,
    fontWeight: "600",
    flex: 1,
  },
  cachedRetryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  cachedRetryText: {
    fontSize: 12,
    fontWeight: "700",
  },
});
