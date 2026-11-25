import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import {
  AlarmClock,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  Sparkles,
  X,
  Zap,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  resolveCarouselCardHeader,
  searchThreadCards,
  stepMatchIndex,
  type SearchableThreadCard,
} from "../../../../src/shared/done-stack";
import type { LoopClient } from "../api/client";
import type { ApiSnippet } from "../api/types";
import {
  QUICK_REPLIES,
  relativeTime,
  type NativeResultCard,
} from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { AgentAvatar, InlineFormattedText, RichContent } from "./RichContent";

const CARD_GAP = 10;
const DISMISS_THRESHOLD = 100;

type SpotlightCarouselProps = {
  cards: NativeResultCard[];
  client?: LoopClient | null;
  snippets?: ApiSnippet[];
  theme: LoopTheme;
  onClose: () => void;
  onOpenAgent?: (agentId: string | null | undefined, agentName: string) => void;
  onOpenThread?: (card: NativeResultCard) => void;
  onMarkRead: (card: NativeResultCard) => void;
  onToggleSaved: (card: NativeResultCard) => void;
  onRemind: (card: NativeResultCard) => void;
  onDismissCard: (card: NativeResultCard) => void;
  onSendReply: (card: NativeResultCard, prompt: string) => Promise<void> | void;
};

export function SpotlightCarousel({
  cards,
  client,
  snippets = [],
  theme,
  onClose,
  onOpenAgent,
  onOpenThread,
  onMarkRead,
  onToggleSaved,
  onRemind,
  onDismissCard,
  onSendReply,
}: SpotlightCarouselProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  const cardWidth = Math.min(Math.round(screenWidth * 0.87), 424);
  const snapInterval = cardWidth + CARD_GAP;
  const sidePadding = Math.max(12, Math.round((screenWidth - cardWidth) / 2));

  // Pin initial order so newly arriving replies never yank you off the card
  // you're reading; instead a "New result arrived" pill lets you jump to #1.
  const [pinnedIds, setPinnedIds] = useState<string[]>(() =>
    cards.map((c) => c.id),
  );
  const cardsById = useMemo(
    () => new Map(cards.map((c) => [c.id, c])),
    [cards],
  );
  const newestLiveId = cards[0]?.id;
  const hasNewArrival = Boolean(
    newestLiveId && !pinnedIds.includes(newestLiveId),
  );

  // In live mode, lazily hydrate full conversation history + truncated bodies
  const [historyPrompts, setHistoryPrompts] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [historySlides, setHistorySlides] = useState<NativeResultCard[]>([]);
  const [fullBodies, setFullBodies] = useState<Map<string, string>>(
    () => new Map(),
  );
  const conversationId = cards[0]?.conversationId;

  useEffect(() => {
    if (!client || !conversationId) return;
    let cancelled = false;
    void client
      .conversation(conversationId)
      .then((page) => {
        if (cancelled) return;
        const promptMap = new Map<string, string>();
        const savedSet = new Set(page.saved);
        const extra: NativeResultCard[] = [];
        let lastPrompt = "";
        const base = cards[0];
        for (const msg of page.messages) {
          if (msg.role === "user") {
            lastPrompt = msg.content;
            continue;
          }
          if (msg.role !== "assistant" || !msg.content.trim()) continue;
          if (lastPrompt) promptMap.set(msg.id, lastPrompt);
          extra.push({
            id: msg.id,
            conversationId,
            tab: "done",
            agentId: base?.agentId,
            agentName: base?.agentName ?? "agent",
            projectName: base?.projectName ?? "Workspace",
            model: base?.model ?? "",
            prompt: lastPrompt || page.conversation.title,
            fallbackTitle: page.conversation.title || "Result",
            body: msg.content,
            createdAt: msg.created_at,
            saved: savedSet.has(msg.id),
            unread: false,
            messageId: msg.id,
          });
          lastPrompt = "";
        }
        extra.reverse();
        setHistoryPrompts(promptMap);
        setHistorySlides(extra);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, conversationId]);

  const slides = useMemo(() => {
    const ordered: NativeResultCard[] = [];
    const seenMsgs = new Set<string>();
    const hydrate = (card: NativeResultCard): NativeResultCard => {
      const msgId = card.messageId;
      if (msgId) seenMsgs.add(msgId);
      const exactPrompt = msgId ? historyPrompts.get(msgId) : undefined;
      const fullBody = msgId ? fullBodies.get(msgId) : undefined;
      return {
        ...card,
        ...(exactPrompt ? { prompt: exactPrompt } : {}),
        ...(fullBody ? { body: fullBody, bodyTruncated: false } : {}),
      };
    };
    for (const id of pinnedIds) {
      const card = cardsById.get(id);
      if (card) ordered.push(hydrate(card));
    }
    if (!ordered.length) {
      for (const card of cards) ordered.push(hydrate(card));
    }
    for (const hist of historySlides) {
      if (!hist.messageId || !seenMsgs.has(hist.messageId)) {
        ordered.push(hist);
      }
    }
    return ordered;
  }, [pinnedIds, cardsById, cards, historyPrompts, historySlides, fullBodies]);

  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = Math.max(
    0,
    Math.min(activeIndex, Math.max(0, slides.length - 1)),
  );
  const activeCard = slides[safeIndex];
  const agentName = activeCard?.agentName ?? cards[0]?.agentName ?? "agent";

  // Mode-A Live Search Overlay + persistent Prev/Next match chip
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);

  // Detached floating Reply composer
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const scrollRef = useRef<Animated.ScrollView>(null);
  const replyInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const searchInputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const markedReadRef = useRef(new Set<string>());

  // Native animation shared values
  const entrance = useSharedValue(0);
  const dismissY = useSharedValue(0);
  const dismissThresholdCrossed = useSharedValue(false);
  const scrollX = useSharedValue(0);
  const lastCenteredIdx = useSharedValue(0);

  useEffect(() => {
    entrance.value = withSpring(1, { damping: 24, stiffness: 280, mass: 0.85 });
  }, []);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Mark active card read + lazily hydrate full body when truncated
  useEffect(() => {
    if (!activeCard) return;
    if (activeCard.unread && !markedReadRef.current.has(activeCard.id)) {
      markedReadRef.current.add(activeCard.id);
      onMarkRead(activeCard);
    }
    if (
      client &&
      activeCard.bodyTruncated &&
      activeCard.messageId &&
      !fullBodies.has(activeCard.messageId)
    ) {
      const msgId = activeCard.messageId;
      void client
        .messageDetail(msgId)
        .then((detail) => {
          setFullBodies((prev) => {
            if (prev.has(msgId)) return prev;
            const next = new Map(prev);
            next.set(msgId, detail.content);
            return next;
          });
        })
        .catch(() => {});
    }
  }, [activeCard, client, fullBodies, onMarkRead]);

  // Close cleanly when all cards in the stack are dismissed
  useEffect(() => {
    if (slides.length === 0) onClose();
  }, [slides.length, onClose]);

  const animateClose = useCallback(() => {
    Keyboard.dismiss();
    entrance.value = withTiming(0, { duration: 180 }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
  }, [onClose]);

  const scrollToSlide = useCallback(
    (index: number, animated = true) => {
      const clamped = Math.max(0, Math.min(index, slides.length - 1));
      setActiveIndex(clamped);
      lastCenteredIdx.value = clamped;
      scrollRef.current?.scrollTo({
        x: clamped * snapInterval,
        y: 0,
        animated,
      });
    },
    [slides.length, snapInterval],
  );

  const handleCenteredChange = useCallback((nextIdx: number) => {
    haptics.selection();
    setActiveIndex(nextIdx);
  }, []);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
      const idx = Math.round(event.contentOffset.x / snapInterval);
      if (idx !== lastCenteredIdx.value && idx >= 0) {
        lastCenteredIdx.value = idx;
        runOnJS(handleCenteredChange)(idx);
      }
    },
  });

  // Interactive swipe-down-to-dismiss on the ambient top bar
  const fireDismissTick = () => haptics.light();

  const dismissPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .onUpdate((e) => {
          const dy = Math.max(0, e.translationY);
          dismissY.value = dy;
          const crossed = dy >= DISMISS_THRESHOLD;
          if (crossed !== dismissThresholdCrossed.value) {
            dismissThresholdCrossed.value = crossed;
            if (crossed) runOnJS(fireDismissTick)();
          }
        })
        .onEnd((e) => {
          const shouldClose =
            e.translationY >= DISMISS_THRESHOLD || e.velocityY > 750;
          dismissThresholdCrossed.value = false;
          if (shouldClose) {
            dismissY.value = withTiming(340, { duration: 190 });
            entrance.value = withTiming(0, { duration: 190 }, (finished) => {
              if (finished) runOnJS(onClose)();
            });
          } else {
            dismissY.value = withSpring(0, {
              damping: 22,
              stiffness: 300,
            });
          }
        }),
    [onClose],
  );

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    const dragFade = interpolate(
      dismissY.value,
      [0, 260],
      [1, 0.15],
      Extrapolation.CLAMP,
    );
    return {
      opacity: entrance.value * dragFade,
    };
  });

  const stageAnimatedStyle = useAnimatedStyle(() => {
    const enterScale = interpolate(entrance.value, [0, 1], [0.92, 1]);
    const dragScale = interpolate(
      dismissY.value,
      [0, 280],
      [1, 0.87],
      Extrapolation.CLAMP,
    );
    return {
      opacity: entrance.value,
      transform: [
        { translateY: dismissY.value },
        { scale: enterScale * dragScale },
      ],
    };
  });

  // Resolved headers & Mode-A search data
  const headers = useMemo(
    () =>
      slides.map((slide) =>
        resolveCarouselCardHeader({
          prompt: slide.prompt,
          body: slide.body,
          fallback: slide.fallbackTitle,
        }),
      ),
    [slides],
  );

  const searchableCards = useMemo<SearchableThreadCard[]>(
    () =>
      slides.map((slide, idx) => ({
        id: slide.id,
        title: headers[idx]?.title ?? slide.fallbackTitle,
        prompt: slide.prompt,
        body: slide.body,
        createdAt: slide.createdAt,
        saved: slide.saved,
        unread: slide.unread,
      })),
    [slides, headers],
  );

  const liveHits = useMemo(
    () => searchThreadCards(searchableCards, searchQuery),
    [searchableCards, searchQuery],
  );
  const committedHits = useMemo(
    () => searchThreadCards(searchableCards, committedQuery),
    [searchableCards, committedQuery],
  );
  const activeHits = searchOpen ? liveHits : committedHits;

  const committedMatchPos = useMemo(() => {
    if (!committedHits.length) return -1;
    return committedHits.findIndex((h) => h.index === safeIndex);
  }, [committedHits, safeIndex]);

  const openSearch = useCallback(
    (prefill?: string) => {
      haptics.light();
      if (prefill !== undefined) setSearchQuery(prefill);
      else if (!searchQuery && committedQuery) setSearchQuery(committedQuery);
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 40);
    },
    [searchQuery, committedQuery],
  );

  const selectHit = useCallback(
    (index: number, query: string) => {
      haptics.medium();
      const trimmed = query.trim();
      setCommittedQuery(trimmed);
      setSearchQuery(trimmed);
      setSearchOpen(false);
      Keyboard.dismiss();
      requestAnimationFrame(() => scrollToSlide(index, true));
    },
    [scrollToSlide],
  );

  const stepMatch = useCallback(
    (dir: "prev" | "next") => {
      const next = stepMatchIndex(committedHits, safeIndex, dir);
      if (next !== null) {
        haptics.selection();
        scrollToSlide(next, true);
      }
    },
    [committedHits, safeIndex, scrollToSlide],
  );

  const clearSearch = useCallback(() => {
    haptics.light();
    setSearchQuery("");
    setCommittedQuery("");
    setSearchOpen(false);
  }, []);

  const prefillReply = useCallback((prompt: string) => {
    setDraft(prompt);
    setQuickReplyOpen(false);
    setTimeout(() => replyInputRef.current?.focus(), 40);
  }, []);

  const submitReply = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || sending || !activeCard) return;
    haptics.medium();
    setSending(true);
    setDraft("");
    Keyboard.dismiss();
    Promise.resolve(onSendReply(activeCard, trimmed))
      .catch(() => {})
      .finally(() => {
        setTimeout(() => setSending(false), client ? 350 : 1150);
      });
  }, [draft, sending, activeCard, onSendReply, client]);

  const viewNewestArrival = useCallback(() => {
    haptics.medium();
    setPinnedIds(cards.map((c) => c.id));
    requestAnimationFrame(() => scrollToSlide(0, true));
  }, [cards, scrollToSlide]);

  if (!slides.length) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Frosted blurred Feed backdrop */}
      <Animated.View style={[StyleSheet.absoluteFill, backdropAnimatedStyle]}>
        <BlurView
          intensity={68}
          tint={theme.blurTint}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
      </Animated.View>

      {/* Main interactive Spotlight Stage */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Animated.View
          style={[
            styles.stage,
            {
              paddingTop: Math.max(insets.top + 6, 16),
              paddingBottom: keyboardVisible
                ? 8
                : Math.max(insets.bottom + 8, 16),
            },
            stageAnimatedStyle,
          ]}
        >
          {/* Ambient Top Chrome (swipe-down handle) OR Mode-A Search Bar */}
          {searchOpen ? (
            <View style={styles.searchBarRow}>
              <View
                style={[
                  styles.searchInputWrap,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.brass,
                  },
                ]}
              >
                <Search size={16} color={theme.brassText} />
                <TextInput
                  ref={searchInputRef}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder={`Search ${slides.length} ${slides.length === 1 ? "card" : "cards"} in thread…`}
                  placeholderTextColor={theme.muted}
                  style={[styles.searchInput, { color: theme.text }]}
                  returnKeyType="search"
                  autoCorrect={false}
                  onSubmitEditing={() => {
                    if (liveHits.length) {
                      selectHit(liveHits[0].index, searchQuery);
                    } else if (!searchQuery.trim()) {
                      clearSearch();
                    }
                  }}
                />
                {searchQuery.length > 0 && (
                  <Pressable
                    onPress={() => {
                      haptics.light();
                      setSearchQuery("");
                    }}
                    hitSlop={8}
                  >
                    <X size={16} color={theme.muted} />
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={() => {
                  haptics.light();
                  setSearchOpen(false);
                  Keyboard.dismiss();
                }}
                style={styles.cancelBtn}
              >
                <Text style={[styles.cancelText, { color: theme.brassText }]}>
                  Cancel
                </Text>
              </Pressable>
            </View>
          ) : (
            <GestureDetector gesture={dismissPanGesture}>
              <View style={styles.ambientHeaderWrap}>
                <View
                  style={[styles.grabPill, { backgroundColor: theme.line }]}
                />
                <View style={styles.ambientBar}>
                  <Pressable
                    accessibilityLabel="Close carousel"
                    onPress={() => {
                      haptics.light();
                      animateClose();
                    }}
                    style={({ pressed }) => [
                      styles.floatIconBtn,
                      {
                        backgroundColor: theme.pillBg,
                        borderColor: theme.line,
                        transform: [{ scale: pressed ? 0.93 : 1 }],
                      },
                    ]}
                  >
                    <X size={18} color={theme.text} />
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      if (!onOpenAgent) return;
                      haptics.light();
                      onOpenAgent(activeCard?.agentId, agentName);
                    }}
                    style={[
                      styles.identityPill,
                      {
                        backgroundColor: theme.pillBg,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <AgentAvatar name={agentName} size={24} />
                    <Text
                      style={[styles.identityAgent, { color: theme.text }]}
                      numberOfLines={1}
                    >
                      @{agentName}
                    </Text>
                    <Text style={[styles.identitySep, { color: theme.muted }]}>
                      ·
                    </Text>
                    <Text style={[styles.identityPos, { color: theme.muted }]}>
                      {safeIndex + 1} / {slides.length}
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityLabel="Search cards in thread"
                    onPress={() => openSearch()}
                    style={({ pressed }) => [
                      styles.floatIconBtn,
                      {
                        backgroundColor: committedQuery
                          ? theme.attention
                          : theme.pillBg,
                        borderColor: committedQuery
                          ? theme.attentionLine
                          : theme.line,
                        transform: [{ scale: pressed ? 0.93 : 1 }],
                      },
                    ]}
                  >
                    <Search
                      size={17}
                      color={committedQuery ? theme.brassText : theme.text}
                    />
                  </Pressable>
                </View>
              </View>
            </GestureDetector>
          )}

          {/* Simulated arrival / sending status pills */}
          {!searchOpen && sending && (
            <View style={styles.statusBannerWrap}>
              <View
                style={[
                  styles.statusBannerPill,
                  {
                    backgroundColor: theme.pillBg,
                    borderColor: theme.line,
                  },
                ]}
              >
                <Sparkles size={13} color={theme.brassText} />
                <Text style={[styles.statusBannerText, { color: theme.muted }]}>
                  @{agentName} is writing a new card…
                </Text>
              </View>
            </View>
          )}

          {!searchOpen && hasNewArrival && (
            <View style={styles.statusBannerWrap}>
              <Pressable
                onPress={viewNewestArrival}
                style={({ pressed }) => [
                  styles.statusBannerPill,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text
                  style={[styles.statusBannerText, { color: theme.brassText }]}
                >
                  New result arrived · View newest
                </Text>
                <ArrowUpRight size={14} color={theme.brassText} />
              </Pressable>
            </View>
          )}

          {/* Persistent tiny Prev / Next match chip after Enter or hit selection */}
          {!searchOpen && committedQuery.length > 0 && (
            <View style={styles.matchPillWrap}>
              <View
                style={[
                  styles.matchPill,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Pressable
                  onPress={() => openSearch(committedQuery)}
                  style={styles.matchQueryBtn}
                >
                  <Search size={13} color={theme.brassText} />
                  <Text
                    style={[styles.matchQueryText, { color: theme.brassText }]}
                    numberOfLines={1}
                  >
                    “{committedQuery}”
                  </Text>
                  <Text style={[styles.matchCount, { color: theme.muted }]}>
                    {committedHits.length === 0
                      ? "0"
                      : committedMatchPos >= 0
                        ? `${committedMatchPos + 1} / ${committedHits.length}`
                        : `${committedHits.length} ${committedHits.length === 1 ? "hit" : "hits"}`}
                  </Text>
                </Pressable>
                <View style={styles.matchStepRow}>
                  <Pressable
                    disabled={committedHits.length < 2}
                    onPress={() => stepMatch("prev")}
                    style={[
                      styles.matchStepBtn,
                      committedHits.length < 2 && { opacity: 0.35 },
                    ]}
                  >
                    <ChevronLeft size={15} color={theme.text} />
                  </Pressable>
                  <Pressable
                    disabled={committedHits.length < 2}
                    onPress={() => stepMatch("next")}
                    style={[
                      styles.matchStepBtn,
                      committedHits.length < 2 && { opacity: 0.35 },
                    ]}
                  >
                    <ChevronRight size={15} color={theme.text} />
                  </Pressable>
                  <Pressable onPress={clearSearch} style={styles.matchStepBtn}>
                    <X size={14} color={theme.text} />
                  </Pressable>
                </View>
              </View>
            </View>
          )}

          {/* 120fps Horizontal Floating Card Carousel */}
          <View
            style={[styles.trackWrap, searchOpen && { opacity: 0.25 }]}
            pointerEvents={searchOpen ? "none" : "auto"}
          >
            <Animated.ScrollView
              ref={scrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              snapToInterval={snapInterval}
              snapToAlignment="start"
              disableIntervalMomentum
              scrollEventThrottle={16}
              onScroll={scrollHandler}
              contentContainerStyle={{
                paddingHorizontal: sidePadding,
                gap: CARD_GAP,
              }}
            >
              {slides.map((slide, index) => {
                const header = headers[index];
                const isMatch =
                  Boolean((searchOpen ? searchQuery : committedQuery).trim()) &&
                  activeHits.some((h) => h.index === index);
                return (
                  <FloatingCarouselCard
                    key={slide.id}
                    slide={slide}
                    header={header}
                    index={index}
                    isActive={index === safeIndex}
                    isMatch={isMatch}
                    cardWidth={cardWidth}
                    snapInterval={snapInterval}
                    scrollX={scrollX}
                    theme={theme}
                    onSelectNeighbor={() => {
                      haptics.light();
                      scrollToSlide(index, true);
                    }}
                    onToggleSaved={() => {
                      haptics.medium();
                      onToggleSaved(slide);
                    }}
                    onRemind={() => {
                      haptics.light();
                      onRemind(slide);
                    }}
                    onQuick={() => {
                      haptics.light();
                      setQuickReplyOpen(true);
                    }}
                    onDone={() => {
                      haptics.success();
                      onDismissCard(slide);
                    }}
                    onReplyButton={prefillReply}
                  />
                );
              })}
            </Animated.ScrollView>
          </View>

          {/* Mode-A Live Search Hit Dropdown floating above dimmed card deck */}
          {searchOpen && (
            <View
              style={[
                styles.searchDropdown,
                {
                  top: Math.max(insets.top + 58, 68),
                  backgroundColor: theme.surface,
                  borderColor: theme.line,
                },
              ]}
            >
              {searchQuery.trim() ? (
                <>
                  <View style={styles.searchMetaRow}>
                    <Text
                      style={[styles.searchMetaText, { color: theme.muted }]}
                    >
                      {liveHits.length === 0
                        ? "No matching cards"
                        : `${liveHits.length} ${liveHits.length === 1 ? "match" : "matches"} in ${slides.length} cards`}
                    </Text>
                    {liveHits.length > 0 && (
                      <Text
                        style={[styles.searchMetaText, { color: theme.muted }]}
                      >
                        Tap to jump
                      </Text>
                    )}
                  </View>
                  <ScrollView
                    style={styles.hitList}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    {liveHits.map((hit, idx) => (
                      <Pressable
                        key={hit.cardId}
                        onPress={() => selectHit(hit.index, searchQuery)}
                        style={({ pressed }) => [
                          styles.hitItem,
                          {
                            backgroundColor:
                              idx === 0 || pressed
                                ? theme.attention
                                : theme.soft,
                            borderColor:
                              idx === 0 || pressed
                                ? theme.attentionLine
                                : theme.line,
                          },
                        ]}
                      >
                        <View style={styles.hitTopRow}>
                          <Text
                            style={[
                              styles.hitIndex,
                              { color: theme.brassText },
                            ]}
                          >
                            #{hit.index + 1}
                          </Text>
                          <Text
                            style={[styles.hitTitle, { color: theme.text }]}
                            numberOfLines={2}
                          >
                            {hit.title}
                          </Text>
                          {hit.saved ? (
                            <View
                              style={[
                                styles.hitSavedBadge,
                                {
                                  backgroundColor: theme.attention,
                                  borderColor: theme.attentionLine,
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.hitSavedText,
                                  { color: theme.brassText },
                                ]}
                              >
                                Saved
                              </Text>
                            </View>
                          ) : (
                            <Text
                              style={[styles.hitTime, { color: theme.muted }]}
                            >
                              {relativeTime(hit.createdAt)}
                            </Text>
                          )}
                        </View>
                        <Text
                          style={[styles.hitSnippet, { color: theme.muted }]}
                          numberOfLines={2}
                        >
                          {hit.snippet.map((seg, sIdx) =>
                            seg.hit ? (
                              <Text
                                key={sIdx}
                                style={{
                                  backgroundColor: theme.attentionLine,
                                  color: theme.text,
                                  fontWeight: "700",
                                }}
                              >
                                {seg.text}
                              </Text>
                            ) : (
                              <React.Fragment key={sIdx}>
                                {seg.text}
                              </React.Fragment>
                            ),
                          )}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </>
              ) : (
                <Text style={[styles.searchEmptyHint, { color: theme.muted }]}>
                  Try searching “Hetzner”, “residency”, “latency”, or “Fly.io”
                  across all {slides.length} discrete cards.
                </Text>
              )}
            </View>
          )}

          {/* Tactile Dot Rail (hidden while keyboard is up for breathing room) */}
          {slides.length > 1 && !keyboardVisible && (
            <View style={styles.dotsRow}>
              {slides.map((slide, index) => {
                const active = index === safeIndex;
                const isHit =
                  Boolean(committedQuery) &&
                  committedHits.some((h) => h.index === index);
                return (
                  <Pressable
                    key={slide.id}
                    hitSlop={8}
                    onPress={() => {
                      haptics.selection();
                      scrollToSlide(index, true);
                    }}
                    style={[
                      styles.dot,
                      {
                        width: active ? 22 : 7,
                        backgroundColor: active
                          ? theme.brass
                          : isHit
                            ? theme.attentionLine
                            : theme.line,
                      },
                    ]}
                  />
                );
              })}
            </View>
          )}

          {/* Detached Floating Reply Pill (Concept A) */}
          <View style={styles.replyFloatWrap}>
            <View
              style={[
                styles.replyPill,
                {
                  backgroundColor: theme.pillBg,
                  borderColor: theme.line,
                },
              ]}
            >
              <TextInput
                ref={replyInputRef}
                value={draft}
                onChangeText={setDraft}
                placeholder={`Reply to @${agentName}…`}
                placeholderTextColor={theme.muted}
                style={[styles.replyInput, { color: theme.text }]}
                multiline
                maxLength={1200}
                returnKeyType="default"
              />
              {onOpenThread && activeCard && (
                <Pressable
                  accessibilityLabel="Open full thread"
                  onPress={() => {
                    haptics.light();
                    onOpenThread(activeCard);
                  }}
                  style={styles.replyOpenThreadBtn}
                >
                  <ArrowUpRight size={17} color={theme.muted} />
                </Pressable>
              )}
              <Pressable
                accessibilityLabel="Send reply"
                disabled={!draft.trim() || sending}
                onPress={submitReply}
                style={({ pressed }) => [
                  styles.replySendBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity:
                      !draft.trim() || sending ? 0.36 : pressed ? 0.85 : 1,
                    transform: [{ scale: pressed ? 0.93 : 1 }],
                  },
                ]}
              >
                <ArrowUp size={17} color={theme.onBrass} strokeWidth={2.4} />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>

      {/* Frosted Quick Reply Sheet */}
      {quickReplyOpen && (
        <Pressable
          style={[
            StyleSheet.absoluteFill,
            styles.quickSheetOverlay,
            { backgroundColor: "rgba(0,0,0,0.45)" },
          ]}
          onPress={() => setQuickReplyOpen(false)}
        >
          <Pressable
            style={[
              styles.quickSheet,
              {
                backgroundColor: theme.surface,
                borderColor: theme.line,
                paddingBottom: Math.max(insets.bottom + 14, 22),
              },
            ]}
            onPress={() => {}}
          >
            <View style={styles.quickSheetHead}>
              <Text style={[styles.quickSheetTitle, { color: theme.text }]}>
                Quick reply
              </Text>
              <Pressable
                onPress={() => {
                  haptics.light();
                  setQuickReplyOpen(false);
                }}
              >
                <X size={18} color={theme.muted} />
              </Pressable>
            </View>
            {QUICK_REPLIES.map((opt) => (
              <Pressable
                key={opt.id}
                onPress={() => {
                  haptics.light();
                  prefillReply(opt.instruction);
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: pressed ? theme.attentionLine : theme.line,
                  },
                ]}
              >
                <Zap size={16} color={theme.brassText} />
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    {opt.label}
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                  >
                    {opt.hint}
                  </Text>
                </View>
              </Pressable>
            ))}
            {snippets.slice(0, 4).map((snip) => (
              <Pressable
                key={snip.id}
                onPress={() => {
                  haptics.light();
                  prefillReply(snip.content);
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: pressed ? theme.attentionLine : theme.line,
                  },
                ]}
              >
                <Sparkles size={16} color={theme.brassText} />
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    /{snip.title}
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {snip.content}
                  </Text>
                </View>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      )}
    </View>
  );
}

function FloatingCarouselCard({
  slide,
  header,
  index,
  isActive,
  isMatch,
  cardWidth,
  snapInterval,
  scrollX,
  theme,
  onSelectNeighbor,
  onToggleSaved,
  onRemind,
  onQuick,
  onDone,
  onReplyButton,
}: {
  slide: NativeResultCard;
  header: ReturnType<typeof resolveCarouselCardHeader>;
  index: number;
  isActive: boolean;
  isMatch: boolean;
  cardWidth: number;
  snapInterval: number;
  scrollX: SharedValue<number>;
  theme: LoopTheme;
  onSelectNeighbor: () => void;
  onToggleSaved: () => void;
  onRemind: () => void;
  onQuick: () => void;
  onDone: () => void;
  onReplyButton: (prompt: string) => void;
}) {
  const animatedCardStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * snapInterval,
      index * snapInterval,
      (index + 1) * snapInterval,
    ];
    const scale = interpolate(
      scrollX.value,
      inputRange,
      [0.935, 1, 0.935],
      Extrapolation.CLAMP,
    );
    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.62, 1, 0.62],
      Extrapolation.CLAMP,
    );
    const translateY = interpolate(
      scrollX.value,
      inputRange,
      [6, 0, 6],
      Extrapolation.CLAMP,
    );
    return {
      transform: [{ scale }, { translateY }],
      opacity,
    };
  });

  const borderColor = isMatch
    ? theme.brass
    : isActive
      ? theme.attentionLine
      : theme.line;

  return (
    <Animated.View
      style={[
        styles.floatCard,
        {
          width: cardWidth,
          backgroundColor: theme.surface,
          borderColor,
        },
        animatedCardStyle,
      ]}
    >
      {/* Tapping a peeking neighbor glides it smoothly into center */}
      {!isActive && (
        <Pressable
          style={[StyleSheet.absoluteFill, { zIndex: 10 }]}
          onPress={onSelectNeighbor}
        />
      )}

      {/* Card Eyebrow (never crowds the title) */}
      <View style={styles.cardEyebrow}>
        <View style={styles.cardBadges}>
          {slide.saved && (
            <View
              style={[
                styles.badgeSaved,
                {
                  backgroundColor: theme.attention,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <BookmarkCheck size={12} color={theme.brassText} />
              <Text style={[styles.badgeSavedText, { color: theme.brassText }]}>
                Saved
              </Text>
            </View>
          )}
          {slide.unread && (
            <View
              style={[
                styles.badgeSaved,
                {
                  backgroundColor: theme.attention,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <Text style={[styles.badgeSavedText, { color: theme.brassText }]}>
                New
              </Text>
            </View>
          )}
          {!slide.saved && !slide.unread && (
            <View
              style={[
                styles.badgePos,
                {
                  backgroundColor: theme.soft,
                  borderColor: theme.line,
                },
              ]}
            >
              <Text style={[styles.badgePosText, { color: theme.muted }]}>
                {index === 0 ? "Latest" : `Card ${index + 1}`}
              </Text>
            </View>
          )}
          <Text style={[styles.cardTime, { color: theme.muted }]}>
            {relativeTime(slide.createdAt)}
          </Text>
        </View>
        <Text style={[styles.cardModelTag, { color: theme.muted }]}>
          {slide.model}
        </Text>
      </View>

      {/* Scrollable Card Body with smart 3-line expandable title + pure native content */}
      <ScrollView
        style={styles.cardScroll}
        contentContainerStyle={styles.cardScrollContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <CarouselCardTitle
          title={header.title}
          compact={header.compactTitle}
          theme={theme}
        />

        {header.promptQuote && (
          <CarouselPromptQuote prompt={header.promptQuote} theme={theme} />
        )}

        <RichContent
          content={slide.body}
          theme={theme}
          onReplyButton={onReplyButton}
          skipLeadingHeading={
            header.titleSource === "heading" ? header.title : undefined
          }
        />
      </ScrollView>

      {/* Per-card discrete action footer */}
      <View
        style={[
          styles.cardFooter,
          {
            borderTopColor: theme.line,
            backgroundColor: theme.surface,
          },
        ]}
      >
        <Pressable
          onPress={onToggleSaved}
          style={({ pressed }) => [
            styles.chipBtn,
            {
              backgroundColor: slide.saved ? theme.attention : theme.soft,
              borderColor: slide.saved ? theme.attentionLine : theme.line,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            },
          ]}
        >
          {slide.saved ? (
            <BookmarkCheck size={13} color={theme.brassText} />
          ) : (
            <Bookmark size={13} color={theme.text} />
          )}
          <Text
            style={[
              styles.chipText,
              { color: slide.saved ? theme.brassText : theme.text },
            ]}
          >
            {slide.saved ? "Saved" : "Save"}
          </Text>
        </Pressable>

        <Pressable
          onPress={onRemind}
          style={({ pressed }) => [
            styles.chipBtn,
            {
              backgroundColor: theme.soft,
              borderColor: theme.line,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            },
          ]}
        >
          <AlarmClock size={13} color={theme.text} />
          <Text style={[styles.chipText, { color: theme.text }]}>Remind</Text>
        </Pressable>

        <Pressable
          onPress={onQuick}
          style={({ pressed }) => [
            styles.chipBtn,
            {
              backgroundColor: theme.soft,
              borderColor: theme.line,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            },
          ]}
        >
          <Zap size={13} color={theme.text} />
          <Text style={[styles.chipText, { color: theme.text }]}>Quick</Text>
        </Pressable>

        <Pressable
          onPress={onDone}
          style={({ pressed }) => [
            styles.chipBtn,
            styles.chipDone,
            {
              backgroundColor: theme.soft,
              borderColor: theme.line,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            },
          ]}
        >
          <Check size={13} color={theme.text} />
          <Text style={[styles.chipText, { color: theme.text }]}>Done</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

function CarouselCardTitle({
  title,
  compact,
  theme,
}: {
  title: string;
  compact: boolean;
  theme: LoopTheme;
}) {
  const [expanded, setExpanded] = useState(false);
  const [totalLines, setTotalLines] = useState<number | null>(null);

  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
  }, [title]);

  const overflows = totalLines !== null && totalLines > 3;
  const clampedLines =
    totalLines === null ? undefined : expanded ? undefined : 3;

  return (
    <View style={styles.titleBlock}>
      <Pressable
        disabled={!overflows && !expanded}
        onPress={() => {
          haptics.light();
          setExpanded((v) => !v);
        }}
      >
        <InlineFormattedText
          text={title}
          theme={theme}
          numberOfLines={clampedLines}
          onTextLayout={(e) => {
            if (totalLines === null) {
              setTotalLines(e.nativeEvent.lines.length);
            }
          }}
          baseStyle={[styles.cardTitle, compact && styles.cardTitleCompact]}
        />
      </Pressable>
      {(overflows || expanded) && (
        <Pressable
          onPress={() => {
            haptics.light();
            setExpanded((v) => !v);
          }}
          style={[
            styles.expandToggle,
            {
              backgroundColor: theme.soft,
              borderColor: theme.line,
            },
          ]}
        >
          <Text style={[styles.expandToggleText, { color: theme.brassText }]}>
            {expanded ? "Show less" : "Show full"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function CarouselPromptQuote({
  prompt,
  theme,
}: {
  prompt: string;
  theme: LoopTheme;
}) {
  const [expanded, setExpanded] = useState(false);
  const [totalLines, setTotalLines] = useState<number | null>(null);

  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
  }, [prompt]);

  const overflows = totalLines !== null && totalLines > 2;
  const clampedLines =
    totalLines === null ? undefined : expanded ? undefined : 2;

  return (
    <Pressable
      disabled={!overflows && !expanded}
      onPress={() => {
        haptics.light();
        setExpanded((v) => !v);
      }}
      style={[
        styles.promptQuote,
        {
          backgroundColor: theme.soft,
          borderColor: theme.line,
        },
      ]}
    >
      <View style={styles.promptHead}>
        <Text style={[styles.promptLabel, { color: theme.muted }]}>
          YOU ASKED
        </Text>
        {(overflows || expanded) && (
          <View
            style={[
              styles.expandToggle,
              {
                marginTop: 0,
                backgroundColor: theme.surface,
                borderColor: theme.line,
              },
            ]}
          >
            <Text style={[styles.expandToggleText, { color: theme.brassText }]}>
              {expanded ? "Show less" : "Show full"}
            </Text>
          </View>
        )}
      </View>
      <Text
        style={[styles.promptBody, { color: theme.text }]}
        numberOfLines={clampedLines}
        onTextLayout={(e) => {
          if (totalLines === null) {
            setTotalLines(e.nativeEvent.lines.length);
          }
        }}
      >
        {prompt}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  stage: {
    flex: 1,
  },
  ambientHeaderWrap: {
    alignItems: "center",
    paddingBottom: 10,
  },
  grabPill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
    opacity: 0.7,
  },
  ambientBar: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  floatIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  identityPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingLeft: 6,
    paddingRight: 13,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "65%",
  },
  identityAgent: {
    fontSize: 13.5,
    fontWeight: "700",
    flexShrink: 1,
  },
  identitySep: {
    fontSize: 13,
  },
  identityPos: {
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  searchBarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 13,
    height: 42,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
  },
  cancelBtn: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  cancelText: {
    fontSize: 15,
    fontWeight: "600",
  },
  searchDropdown: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: 20,
    borderWidth: 1,
    padding: 12,
    gap: 8,
    maxHeight: "54%",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
    zIndex: 20,
  },
  searchMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 2,
  },
  searchMetaText: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  searchEmptyHint: {
    fontSize: 13.5,
    lineHeight: 20,
    padding: 4,
  },
  hitList: {
    maxHeight: 290,
  },
  hitItem: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    gap: 4,
    marginBottom: 7,
  },
  hitTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  hitIndex: {
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  hitTitle: {
    flex: 1,
    fontSize: 13.5,
    fontWeight: "700",
    lineHeight: 18,
  },
  hitSavedBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  hitSavedText: {
    fontSize: 10.5,
    fontWeight: "700",
  },
  hitTime: {
    fontSize: 11,
  },
  hitSnippet: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  statusBannerWrap: {
    alignItems: "center",
    paddingBottom: 8,
  },
  statusBannerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusBannerText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  matchPillWrap: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  matchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "92%",
  },
  matchQueryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  matchQueryText: {
    fontSize: 12.5,
    fontWeight: "700",
    maxWidth: 135,
  },
  matchCount: {
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  matchStepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  matchStepBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  trackWrap: {
    flex: 1,
    paddingVertical: 4,
  },
  floatCard: {
    height: "100%",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.42,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
  cardEyebrow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  cardBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  badgeSaved: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeSavedText: {
    fontSize: 11,
    fontWeight: "700",
  },
  badgePos: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgePosText: {
    fontSize: 11,
    fontWeight: "600",
  },
  cardTime: {
    fontSize: 12,
  },
  cardModelTag: {
    fontSize: 11,
    fontWeight: "500",
  },
  cardScroll: {
    flex: 1,
  },
  cardScrollContent: {
    paddingHorizontal: 17,
    paddingTop: 2,
    paddingBottom: 18,
  },
  titleBlock: {
    marginBottom: 12,
    alignItems: "flex-start",
  },
  cardTitle: {
    fontSize: 19,
    lineHeight: 25,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  cardTitleCompact: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "600",
  },
  expandToggle: {
    marginTop: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  expandToggleText: {
    fontSize: 11,
    fontWeight: "700",
  },
  promptQuote: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 14,
    gap: 4,
  },
  promptHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  promptLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  promptBody: {
    fontSize: 13,
    lineHeight: 19,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chipBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipDone: {
    marginLeft: "auto",
  },
  chipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 8,
  },
  dot: {
    height: 7,
    borderRadius: 3.5,
  },
  replyFloatWrap: {
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  replyPill: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 26,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  replyInput: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    maxHeight: 90,
    paddingVertical: 6,
  },
  replyOpenThreadBtn: {
    width: 32,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  replySendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  quickSheetOverlay: {
    justifyContent: "flex-end",
    zIndex: 40,
  },
  quickSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 16,
    gap: 10,
  },
  quickSheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  quickSheetTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  quickOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  quickOptionText: {
    flex: 1,
    gap: 2,
  },
  quickOptionLabel: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  quickOptionHint: {
    fontSize: 12.5,
  },
});
