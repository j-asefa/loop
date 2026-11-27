import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
import * as Clipboard from "expo-clipboard";
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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  CornerUpLeft,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CAROUSEL_PAGE_CARDS,
  resolveCarouselCardHeader,
  searchThreadCards,
  stepMatchIndex,
  type SearchableThreadCard,
} from "../../../../src/shared/done-stack";
import {
  isUncertainOutcomeError,
  LoopApiError,
  randomUuid,
  type LoopClient,
} from "../api/client";
import type { LoopFileTarget, PublishedFileItem } from "../api/files";
import type { LiveStreamOverlay } from "../api/socket";
import type { ApiConversationPage, ApiSnippet } from "../api/types";
import type { AgentRunSummary } from "./AgentProfileSheet";
import { PublishedFilesStrip } from "./FilePreviewModal";
import {
  carouselCardKey,
  mergeCarouselHistoryPage,
  openingCarouselCardIds,
  reconcileCarouselSaves,
  resolveCarouselSelection,
  QUICK_REPLIES,
  type CarouselHistoryPage,
  type CarouselSaveEdit,
  relativeTime,
  type NativeResultCard,
} from "../fixtures";
import {
  clearDraft,
  draftScopeForCarousel,
  loadDraftEntry,
  saveDraft,
  saveDraftAndFlush,
} from "../drafts";
import { haptics } from "../haptics";
import { runModelLabel } from "../models";
import type { LoopTheme } from "../theme";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
import { AgentAvatar, InlineFormattedText, RichContent } from "./RichContent";
import { PagerLock } from "../pager-lock";
import { ScheduleSendSheet } from "./ScheduleSendSheet";
import { VoiceRecorderButton } from "./VoiceRecorder";
import {
  computeKeyboardInset,
  computeQuickSheetLayout,
} from "../snippet-usage-codec";

const CARD_GAP = 10;
const DISMISS_THRESHOLD = 100;
const EMPTY_PUBLISHED_FILES: PublishedFileItem[] = [];

type SpotlightCarouselProps = {
  cards: NativeResultCard[];
  openingCard?: NativeResultCard;
  queuedRuns?: AgentRunSummary[];
  activeRun?: AgentRunSummary | null;
  canPause?: boolean;
  liveStream?: LiveStreamOverlay | null;
  client?: LoopClient | null;
  snippets?: ApiSnippet[];
  theme: LoopTheme;
  onClose: () => void;
  onCancelQueuedRun?: (runId: string) => void;
  onReorderQueuedRun?: (runId: string, direction: "up" | "down") => void;
  onControlRun?: (
    runId: string,
    action: "pause" | "resume" | "cancel" | "retry",
  ) => void;
  onOpenAgent?: (agentId: string | null | undefined, agentName: string) => void;
  onOpenThread?: (card: NativeResultCard) => void;
  onOpenFile?: (file: PublishedFileItem) => void;
  onOpenFileTarget?: (target: LoopFileTarget, label?: string) => void;
  onMarkRead: (card: NativeResultCard) => void;
  onToggleSaved: (
    card: NativeResultCard,
  ) => Promise<"committed" | "uncertain" | "stale" | void> | void;
  onRemind: (card: NativeResultCard) => void;
  onDismissCard: (card: NativeResultCard) => void;
  onNotify?: (message: string) => void;
  onSendReply: (
    card: NativeResultCard,
    prompt: string,
    attachmentIds?: string[],
    idempotencyKey?: string,
    queue?: boolean,
  ) => Promise<void> | void;
  onScheduleReply?: (
    card: NativeResultCard,
    prompt: string,
    attachmentIds: string[],
    idempotencyKey: string,
    sendAt: number,
  ) => Promise<void>;
};

function parseConversationPageToSlides(
  page: ApiConversationPage,
  base: NativeResultCard | undefined,
): {
  promptMap: Map<string, string>;
  bodyMap: Map<string, string>;
  runIdMap: Map<string, string>;
  slides: NativeResultCard[];
} {
  const promptMap = new Map<string, string>();
  const bodyMap = new Map<string, string>();
  const runIdMap = new Map<string, string>();
  const savedSet = new Set(page.saved);
  const extra: NativeResultCard[] = [];
  let lastPrompt = "";
  for (const msg of page.messages) {
    if (msg.role === "user") {
      lastPrompt = msg.content;
      continue;
    }
    if (msg.role !== "assistant" || !msg.content.trim()) continue;
    const prompt = msg.carousel_prompt || lastPrompt;
    if (prompt) promptMap.set(msg.id, prompt);
    if (msg.run_id) runIdMap.set(msg.id, msg.run_id);
    bodyMap.set(msg.id, msg.content);
    extra.push({
      id: msg.id,
      conversationId: page.conversation.id,
      tab: "done",
      agentId: base?.agentId,
      agentName: base?.agentName ?? "agent",
      projectName: base?.projectName ?? "Workspace",
      model: base?.model ?? "",
      prompt: prompt || page.conversation.title,
      fallbackTitle: page.conversation.title || "Result",
      body: msg.content,
      createdAt: msg.created_at,
      saved: savedSet.has(msg.id),
      unread: false,
      messageId: msg.id,
      runId: msg.run_id ?? undefined,
    });
    lastPrompt = "";
  }
  extra.reverse();
  return { promptMap, bodyMap, runIdMap, slides: extra };
}

export function SpotlightCarousel({
  cards,
  openingCard,
  queuedRuns = [],
  activeRun = null,
  canPause = true,
  liveStream = null,
  client,
  snippets = [],
  theme,
  onClose,
  onCancelQueuedRun,
  onReorderQueuedRun,
  onControlRun,
  onOpenAgent,
  onOpenThread,
  onOpenFile,
  onOpenFileTarget,
  onMarkRead,
  onToggleSaved,
  onRemind,
  onDismissCard,
  onNotify,
  onSendReply,
  onScheduleReply,
}: SpotlightCarouselProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const cardWidth = Math.min(Math.round(screenWidth * 0.87), 424);
  const snapInterval = cardWidth + CARD_GAP;
  const sidePadding = Math.max(12, Math.round((screenWidth - cardWidth) / 2));

  // Pin the order so a refresh never reshuffles the stack; a newly arriving
  // card re-pins it and takes you to that card (#1) once the reply keyboard
  // is closed.
  const recentCards = useMemo(
    () => (client ? cards.slice(0, CAROUSEL_PAGE_CARDS) : cards),
    [cards, client],
  );
  const [pinnedIds, setPinnedIds] = useState(() =>
    openingCarouselCardIds(cards, recentCards, openingCard),
  );
  const cardsById = useMemo(
    () => new Map(cards.map((card) => [card.id, card])),
    [cards],
  );
  const cardsByMessageId = useMemo(() => {
    const byMessageId = new Map<string, NativeResultCard>();
    for (const card of cards) {
      if (card.messageId && !byMessageId.has(card.messageId)) {
        byMessageId.set(card.messageId, card);
      }
    }
    return byMessageId;
  }, [cards]);
  const topCardId = recentCards[0]?.id;
  const lastTopCardRef = useRef(topCardId);

  const conversationId = cards[0]?.conversationId;
  const [initialHistory] = useState(() => {
    const page = conversationId
      ? client?.cachedCarouselPage(conversationId)
      : undefined;
    return page
      ? {
          ...parseConversationPageToSlides(page, cards[0]),
          next: page.next,
          saved: page.saved,
        }
      : undefined;
  });
  // Seed the first render from a cached page, then revalidate in the background.
  const [historyPrompts, setHistoryPrompts] = useState<Map<string, string>>(
    () => initialHistory?.promptMap ?? new Map(),
  );
  const [historyRunIds, setHistoryRunIds] = useState<Map<string, string>>(
    () => initialHistory?.runIdMap ?? new Map(),
  );
  const [history, setHistory] = useState<CarouselHistoryPage>(() => ({
    cards: initialHistory?.slides ?? [],
    next: initialHistory?.next ?? null,
  }));
  const { cards: historySlides, next: historyNextCursor } = history;
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(Boolean(initialHistory));
  const [historyRetry, setHistoryRetry] = useState<string>();
  const [serverSavedIds, setServerSavedIds] = useState<Set<string> | undefined>(
    () => initialHistory && new Set(initialHistory.saved),
  );
  const [savedEdits, setSavedEdits] = useState(
    new Map<string, CarouselSaveEdit>(),
  );
  const saveRevisionRef = useRef(0);
  const savingCardKeysRef = useRef(new Set<string>());
  const [fetchedHistory, setFetchedHistory] = useState<ApiConversationPage>();
  const appliedHistoryRef = useRef<ApiConversationPage | undefined>(undefined);
  const hasLoadedOlderHistoryRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const autoLoadedCursorRef = useRef<string | null>(null);
  const [fullBodies, setFullBodies] = useState<Map<string, string>>(
    () => initialHistory?.bodyMap ?? new Map(),
  );
  const [runFilesByRunId, setRunFilesByRunId] = useState<
    Map<string, PublishedFileItem[]>
  >(() => new Map());
  const fetchedRunsRef = useRef(new Set<string>());
  // Read slide metadata through a ref so mark-read/save/silent reloads do not re-fire
  // `client.conversation(conversationId)` on every `cards` array identity change.
  const baseCardRef = useRef(cards[0]);
  baseCardRef.current = cards[0];

  useEffect(() => {
    if (!client || !conversationId) return;
    let cancelled = false;
    const requestRevision = saveRevisionRef.current;
    void client
      .refreshCarouselPage(
        conversationId,
        JSON.stringify([
          activeRun?.id,
          activeRun?.state,
          topCardId,
          historyRetry,
        ]),
      )
      .then((page) => {
        if (cancelled) return;
        setHistoryUnavailable(false);
        setServerSavedIds(new Set(page.saved));
        setSavedEdits((prev) =>
          reconcileCarouselSaves(prev, page.saved, requestRevision),
        );
        setFetchedHistory(page);
        setSteerableRunId(page.steerable_run_id ?? null);
      })
      .catch(() => {
        if (!cancelled) setHistoryUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    conversationId,
    activeRun?.id,
    activeRun?.state,
    historyRetry,
    topCardId,
  ]);

  const loadMoreHistory = useCallback(async () => {
    if (
      !client ||
      !conversationId ||
      !historyNextCursor ||
      loadingOlderRef.current
    ) {
      return;
    }
    const cursor = historyNextCursor;
    loadingOlderRef.current = true;
    autoLoadedCursorRef.current = cursor;
    setLoadingMoreHistory(true);
    try {
      const page = await client.carouselPage(conversationId, cursor);
      const {
        promptMap,
        bodyMap,
        runIdMap,
        slides: older,
      } = parseConversationPageToSlides(page, baseCardRef.current);
      hasLoadedOlderHistoryRef.current = true;
      setHistoryPrompts((prev) => new Map([...promptMap, ...prev]));
      setHistoryRunIds((prev) => new Map([...runIdMap, ...prev]));
      setFullBodies((prev) => {
        const next = new Map(prev);
        for (const [id, content] of bodyMap) {
          if (!next.has(id)) next.set(id, content);
        }
        return next;
      });
      setHistory((prev) =>
        mergeCarouselHistoryPage(
          prev,
          { cards: older, next: page.next ?? null },
          { before: cursor },
        ),
      );
    } catch {
      // keep existing history
    } finally {
      loadingOlderRef.current = false;
      setLoadingMoreHistory(false);
    }
  }, [client, conversationId, historyNextCursor]);

  const slides = useMemo(() => {
    const ordered: NativeResultCard[] = [];
    const seenMsgs = new Set<string>();
    const hydrate = (card: NativeResultCard): NativeResultCard => {
      const msgId = card.messageId;
      if (msgId) seenMsgs.add(msgId);
      const exactPrompt = msgId ? historyPrompts.get(msgId) : undefined;
      const fullBody = msgId ? fullBodies.get(msgId) : undefined;
      const resolvedRunId =
        card.runId || (msgId ? historyRunIds.get(msgId) : undefined);
      const streamedBody =
        card.tab === "working" && liveStream?.text && !liveStream.gapped
          ? liveStream.text
          : undefined;
      return {
        ...card,
        ...(exactPrompt ? { prompt: exactPrompt } : {}),
        ...(fullBody ? { body: fullBody, bodyTruncated: false } : {}),
        ...(streamedBody
          ? {
              body: streamedBody,
              bodyTruncated: Boolean(liveStream?.truncated),
            }
          : {}),
        ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      };
    };
    for (const id of pinnedIds) {
      const card = cardsById.get(id);
      if (card) ordered.push(hydrate(card));
    }
    if (!ordered.length) {
      for (const card of recentCards) ordered.push(hydrate(card));
    }
    for (const hist of historySlides) {
      if (!hist.messageId || !seenMsgs.has(hist.messageId)) {
        const feedCard = hist.messageId
          ? cardsByMessageId.get(hist.messageId)
          : undefined;
        ordered.push(hydrate(feedCard ?? hist));
      }
    }
    if (historyUnavailable || (historyLoaded && !historyNextCursor)) {
      const listed = new Set(ordered.map((card) => card.id));
      for (const card of cards) {
        if (
          !listed.has(card.id) &&
          (!card.messageId || !seenMsgs.has(card.messageId))
        ) {
          ordered.push(hydrate(card));
        }
      }
    }
    return ordered.map((card) => {
      const edited = savedEdits.get(carouselCardKey(card));
      const saved =
        edited?.saved ??
        (card.messageId && serverSavedIds
          ? serverSavedIds.has(card.messageId)
          : card.saved);
      return saved === card.saved ? card : { ...card, saved };
    });
  }, [
    pinnedIds,
    savedEdits,
    serverSavedIds,
    cards,
    historyUnavailable,
    historyLoaded,
    historyNextCursor,
    cardsById,
    cardsByMessageId,
    recentCards,
    historyPrompts,
    historyRunIds,
    historySlides,
    fullBodies,
    liveStream?.text,
    liveStream?.gapped,
    liveStream?.truncated,
  ]);

  const [selection, setSelection] = useState<{ index: number; key?: string }>({
    index: 0,
  });
  const safeIndex = resolveCarouselSelection(slides, selection);
  const activeCard = slides[safeIndex];

  useEffect(() => {
    // Wait until the user moves toward the older end of the loaded cards.
    if (
      historyNextCursor &&
      !loadingMoreHistory &&
      safeIndex > 0 &&
      safeIndex >= slides.length - 2 &&
      autoLoadedCursorRef.current !== historyNextCursor
    ) {
      void loadMoreHistory();
    }
  }, [
    historyNextCursor,
    loadMoreHistory,
    loadingMoreHistory,
    safeIndex,
    slides.length,
  ]);

  const agentName = activeCard?.agentName ?? cards[0]?.agentName ?? "agent";

  // Mode-A Live Search Overlay + persistent Prev/Next match chip
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [queuedSheetOpen, setQueuedSheetOpen] = useState(false);

  // Detached floating Reply composer + long-press card action sheet
  const [actionSheetCard, setActionSheetCard] =
    useState<NativeResultCard | null>(null);
  const [draft, setDraft] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const draftScope = conversationId
    ? draftScopeForCarousel(conversationId)
    : "";
  const draftTouchedRef = useRef(false);
  const restoredPendingReplyRef = useRef<{
    idempotencyKey: string;
    queue?: boolean;
  } | null>(null);
  const restoredPendingScheduleRef = useRef<{
    idempotencyKey: string;
    sendAt: number;
    input: string;
    agentId?: string;
    attachmentIds: string[];
    replyToMessageId?: string;
    locked: boolean;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  useEffect(() => {
    if (!draftScope) return;
    let cancelled = false;
    draftTouchedRef.current = false;
    void loadDraftEntry(client?.origin, draftScope).then((entry) => {
      if (cancelled) return;
      setDraftLoaded(true);
      if (!entry?.text) return;
      if (entry.pendingSchedule) {
        const restored = {
          idempotencyKey: entry.pendingSchedule.key,
          sendAt: entry.pendingSchedule.sendAt,
          input: entry.pendingSchedule.input ?? entry.text,
          agentId: entry.pendingSchedule.agentId,
          attachmentIds: entry.pendingSchedule.attachmentIds ?? [],
          replyToMessageId: entry.pendingSchedule.replyToMessageId,
          locked: true,
        };
        restoredPendingScheduleRef.current = restored;
        setPendingSchedule(restored);
        setDraft(entry.text);
        return;
      }
      if (!draftTouchedRef.current) {
        if (entry.pendingKey) {
          restoredPendingReplyRef.current = {
            idempotencyKey: entry.pendingKey,
            queue: entry.pendingQueue,
          };
          if (entry.pendingQueue !== undefined) {
            setDeliveryMode(entry.pendingQueue ? "queue" : "steer");
          }
        }
        setDraft(entry.text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client?.origin, draftScope]);
  const [replyError, setReplyError] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<{
    idempotencyKey: string;
    sendAt: number;
    input: string;
    agentId?: string;
    attachmentIds: string[];
    replyToMessageId?: string;
    locked: boolean;
  } | null>(null);
  const initialMetrics = Keyboard.metrics?.();
  const [keyboardCoords, setKeyboardCoords] = useState<{
    height?: number;
    screenY?: number;
  } | null>(() =>
    initialMetrics && initialMetrics.height > 0
      ? { height: initialMetrics.height, screenY: initialMetrics.screenY }
      : null,
  );
  const [stageHeight, setStageHeight] = useState(0);
  const effectiveStageHeight = stageHeight > 0 ? stageHeight : screenHeight;
  const effectiveStageHeightRef = useRef(effectiveStageHeight);
  effectiveStageHeightRef.current = effectiveStageHeight;
  const keyboardInset = keyboardCoords
    ? computeKeyboardInset(
        { endCoordinates: keyboardCoords },
        effectiveStageHeight,
        Platform.OS,
      )
    : 0;
  const keyboardVisible = Boolean(keyboardCoords);
  const [steerableRunId, setSteerableRunId] = useState<string | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<"steer" | "queue">("steer");
  const [retryModeLocked, setRetryModeLocked] = useState(false);
  // Preserve idempotencyKey, replyToMessageId, and queue delivery mode across retries after
  // uncertain errors so retrying never mutates the request semantics for the same idempotencyKey.
  const pendingReplyRef = useRef<{
    idempotencyKey: string;
    replyToMessageId?: string;
    queue?: boolean;
  } | null>(null);
  const replyAttachments = useAttachments(client, {
    agentId: activeCard?.agentId,
  });

  const holdHistoryUpdates =
    !draftLoaded || keyboardVisible || recordingAudio || sending;
  useEffect(() => {
    const page = fetchedHistory;
    if (
      !page ||
      appliedHistoryRef.current === page ||
      !draftLoaded ||
      (historyLoaded && holdHistoryUpdates)
    )
      return;
    appliedHistoryRef.current = page;
    setHistoryLoaded(true);
    const {
      promptMap,
      bodyMap,
      runIdMap,
      slides: extra,
    } = parseConversationPageToSlides(page, baseCardRef.current);
    const keepOlder =
      loadingOlderRef.current || hasLoadedOlderHistoryRef.current;
    setHistoryPrompts((prev) =>
      keepOlder ? new Map([...prev, ...promptMap]) : promptMap,
    );
    setHistoryRunIds((prev) =>
      keepOlder ? new Map([...prev, ...runIdMap]) : runIdMap,
    );
    setFullBodies((prev) => new Map([...prev, ...bodyMap]));
    setHistory((prev) =>
      mergeCarouselHistoryPage(
        prev,
        { cards: extra, next: page.next ?? null },
        keepOlder ? "refresh" : "replace",
      ),
    );
  }, [draftLoaded, fetchedHistory, historyLoaded, holdHistoryUpdates]);

  // Authoritative server capability: only show Steer/Queue toggle when the server reports
  // `steerable_run_id` matching the active run (harnesses with `midTurn: "steer"` / active live input).
  const canSteerActiveRun = Boolean(
    activeRun &&
    activeRun.state === "running" &&
    steerableRunId &&
    steerableRunId === activeRun.id,
  );

  // Invalidate pending retry key ONLY when the reply payload or conversation changes;
  // toggling Steer/Queue after an uncertain timeout is locked so the chip matches the pending retry.
  const attachmentKeySig = replyAttachments.readyIds.join(",");
  useEffect(() => {
    setScheduleError("");
    if (restoredPendingScheduleRef.current) {
      setPendingSchedule(restoredPendingScheduleRef.current);
      restoredPendingScheduleRef.current = null;
    } else {
      setPendingSchedule((prev) => (prev?.locked ? prev : null));
    }
    if (restoredPendingReplyRef.current) {
      pendingReplyRef.current = {
        idempotencyKey: restoredPendingReplyRef.current.idempotencyKey,
        queue: restoredPendingReplyRef.current.queue,
      };
      restoredPendingReplyRef.current = null;
      setRetryModeLocked(true);
      return;
    }
    pendingReplyRef.current = null;
    setRetryModeLocked(false);
  }, [draft, conversationId, attachmentKeySig]);

  const scheduleLocked = Boolean(pendingSchedule?.locked);

  // If the user opened a synthetic working:* placeholder at slide 0 and the run
  // finishes (superseding the placeholder with a live Done card), promote it smoothly.
  useEffect(() => {
    const firstPinned = pinnedIds[0];
    if (
      safeIndex === 0 &&
      firstPinned?.startsWith("working:") &&
      !cardsById.has(firstPinned) &&
      recentCards.length > 0
    ) {
      setPinnedIds(recentCards.map((c) => c.id));
    }
  }, [safeIndex, recentCards, cardsById, pinnedIds]);

  const scrollRef = useRef<Animated.ScrollView>(null);
  // A table or code block being swiped holds the carousel still.
  const [pagerLocked, setPagerLocked] = useState(false);
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
  }, [entrance]);

  useEffect(() => {
    const onShow = (e?: {
      endCoordinates?: { height?: number; screenY?: number };
    }) => {
      setKeyboardCoords(
        e?.endCoordinates
          ? {
              height: e.endCoordinates.height,
              screenY: e.endCoordinates.screenY,
            }
          : { height: 0 },
      );
    };
    const onHide = () => {
      setKeyboardCoords(null);
    };
    const showSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      onShow,
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      onHide,
    );
    const changeSub =
      Platform.OS === "ios"
        ? Keyboard.addListener("keyboardWillChangeFrame", (e) => {
            const screenY = e?.endCoordinates?.screenY;
            const height = e?.endCoordinates?.height;
            if (
              (typeof height === "number" && height <= 0) ||
              (typeof screenY === "number" &&
                Number.isFinite(screenY) &&
                screenY >= effectiveStageHeightRef.current)
            ) {
              onHide();
              return;
            }
            onShow(e);
          })
        : null;
    return () => {
      showSub.remove();
      hideSub.remove();
      changeSub?.remove();
    };
  }, []);

  // Mark active card read + lazily hydrate full body + load published files for the active run
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

  useEffect(() => {
    const runId = activeCard?.runId;
    if (!client || !runId) return;
    const isWorking = activeCard.tab === "working";
    if (!isWorking && fetchedRunsRef.current.has(runId)) return;
    let cancelled = false;
    fetchedRunsRef.current.add(runId);
    void client
      .runFiles(runId)
      .then((files) => {
        if (cancelled) return;
        setRunFilesByRunId((prev) => {
          const next = new Map(prev);
          next.set(runId, files);
          return next;
        });
      })
      .catch(() => {
        fetchedRunsRef.current.delete(runId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCard?.runId, activeCard?.tab, client]);

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

  const selectSlideAt = useCallback(
    (index: number) => {
      const card = slides[index];
      setSelection({ index, key: card && carouselCardKey(card) });
    },
    [slides],
  );

  const scrollToSlide = useCallback(
    (index: number, animated = true) => {
      const clamped = Math.max(0, Math.min(index, slides.length - 1));
      selectSlideAt(clamped);
      lastCenteredIdx.value = clamped;
      scrollRef.current?.scrollTo({
        x: clamped * snapInterval,
        y: 0,
        animated,
      });
    },
    [lastCenteredIdx, selectSlideAt, slides.length, snapInterval],
  );

  // Keep the displayed position and the reply target on the same card
  // when a background response changes the order of the deck.
  useLayoutEffect(() => {
    if (selection.index !== safeIndex) scrollToSlide(safeIndex, false);
    else if (activeCard && selection.key !== carouselCardKey(activeCard))
      selectSlideAt(safeIndex);
  }, [activeCard, safeIndex, scrollToSlide, selectSlideAt, selection]);

  const handleCenteredChange = useCallback(
    (nextIdx: number) => {
      haptics.selection();
      selectSlideAt(nextIdx);
    },
    [selectSlideAt],
  );

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

  // Resolved headers & lazy Mode-A search data
  const headers = useMemo(
    () =>
      slides.map((slide) =>
        resolveCarouselCardHeader({
          prompt: slide.prompt,
          body: slide.body.slice(0, 400),
          fallback: slide.fallbackTitle,
        }),
      ),
    [slides],
  );

  const searchActive = searchOpen || committedQuery.length > 0;
  const searchableCards = useMemo<SearchableThreadCard[]>(() => {
    if (!searchActive) return [];
    return slides.map((slide, idx) => ({
      id: slide.id,
      title: headers[idx]?.title ?? slide.fallbackTitle,
      prompt: slide.prompt,
      body: slide.body,
      createdAt: slide.createdAt,
      saved: slide.saved,
      unread: slide.unread,
    }));
  }, [searchActive, slides, headers]);

  const liveHits = useMemo(
    () => (searchOpen ? searchThreadCards(searchableCards, searchQuery) : []),
    [searchOpen, searchableCards, searchQuery],
  );
  const committedHits = useMemo(
    () =>
      committedQuery ? searchThreadCards(searchableCards, committedQuery) : [],
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

  const focusReplyInput = useCallback(() => {
    haptics.light();
    setTimeout(() => replyInputRef.current?.focus(), 60);
  }, []);

  const prefillReply = useCallback(
    (prompt: string) => {
      if (scheduleLocked) return;
      draftTouchedRef.current = true;
      pendingReplyRef.current = null;
      setReplyError("");
      setDraft(prompt);
      if (draftScope) saveDraft(client?.origin, draftScope, prompt);
      setQuickReplyOpen(false);
      setTimeout(() => replyInputRef.current?.focus(), 60);
    },
    [client?.origin, draftScope, scheduleLocked],
  );

  const handleSlideToggleSaved = useCallback(
    (target: NativeResultCard) => {
      if (client && !target.messageId) return;
      const key = carouselCardKey(target);
      const inFlight = savingCardKeysRef.current;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      const optimistic = {
        revision: ++saveRevisionRef.current,
        saved: !target.saved,
        pending: true,
      };
      setSavedEdits((prev) => new Map(prev).set(key, optimistic));
      const settle = (saved: boolean, uncertain = false) => {
        // Reads started before the mutation settled can still carry the old state.
        const settled = {
          revision: ++saveRevisionRef.current,
          saved,
          uncertain,
        };
        setSavedEdits((prev) =>
          prev.get(key) === optimistic ? new Map(prev).set(key, settled) : prev,
        );
        if (uncertain) setHistoryRetry(randomUuid());
      };
      void Promise.resolve()
        .then(() => onToggleSaved(target))
        .then((outcome) => settle(optimistic.saved, outcome === "uncertain"))
        .catch((err) => {
          if (isUncertainOutcomeError(err)) settle(optimistic.saved, true);
          else settle(target.saved);
        })
        .finally(() => inFlight.delete(key));
    },
    [client, onToggleSaved],
  );

  const submitReply = useCallback(async () => {
    const trimmed = draft.trim();
    const { readyIds, readyNames, uploading, hasErrors, clearAttachments } =
      replyAttachments;
    if (
      (!trimmed && readyIds.length === 0) ||
      uploading ||
      hasErrors ||
      recordingAudio ||
      sendingRef.current ||
      scheduleBusy ||
      pendingSchedule ||
      !activeCard
    ) {
      return;
    }
    const finalPrompt =
      trimmed ||
      (readyNames.length === 1
        ? `Attached ${readyNames[0]}`
        : `Attached ${readyNames.length} files`);
    // Keep one durable idempotency key, reply target, and queue flag per unsent draft so
    // retries after uncertain failures never duplicate or mutate the run request semantics.
    if (!pendingReplyRef.current) {
      pendingReplyRef.current = {
        idempotencyKey: randomUuid(),
        replyToMessageId: activeCard.messageId,
        queue: canSteerActiveRun ? deliveryMode === "queue" : undefined,
      };
    }
    const { idempotencyKey, replyToMessageId, queue } = pendingReplyRef.current;
    const targetCard =
      replyToMessageId === activeCard.messageId
        ? activeCard
        : { ...activeCard, messageId: replyToMessageId };
    sendingRef.current = true;
    haptics.medium();
    setSending(true);
    Keyboard.dismiss();
    setReplyError("");
    try {
      await Promise.resolve(
        onSendReply(targetCard, finalPrompt, readyIds, idempotencyKey, queue),
      );
      pendingReplyRef.current = null;
      setRetryModeLocked(false);
      if (draftScope) clearDraft(client?.origin, draftScope);
      setDraft("");
      clearAttachments();
    } catch (err) {
      if (!isUncertainOutcomeError(err)) {
        pendingReplyRef.current = null;
        setRetryModeLocked(false);
      } else {
        setRetryModeLocked(true);
        if (draftScope) {
          saveDraft(client?.origin, draftScope, draft, {
            key: idempotencyKey,
            queue,
          });
        }
      }
      haptics.warning();
      setReplyError(
        err instanceof Error ? err.message : "Could not send reply. Try again.",
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    draft,
    recordingAudio,
    scheduleBusy,
    pendingSchedule,
    activeCard,
    onSendReply,
    client,
    replyAttachments,
    canSteerActiveRun,
    deliveryMode,
    draftScope,
  ]);

  const submitScheduledReply = useCallback(
    async (sendAt: number) => {
      if (!onScheduleReply || !activeCard || scheduleBusy || sending) return;
      const trimmed = draft.trim();
      const { readyIds, readyNames, uploading, hasErrors, clearAttachments } =
        replyAttachments;
      if (
        !pendingSchedule &&
        ((!trimmed && readyIds.length === 0) || uploading || hasErrors)
      )
        return;
      const finalPrompt =
        pendingSchedule?.input ??
        (trimmed ||
          (readyNames.length === 1
            ? `Attached ${readyNames[0]}`
            : `Attached ${readyNames.length} files`));
      const nextPending = pendingSchedule ?? {
        idempotencyKey: randomUuid(),
        sendAt,
        input: finalPrompt,
        agentId: activeCard.agentId ?? undefined,
        attachmentIds: readyIds,
        replyToMessageId: activeCard.messageId,
        locked: false,
      };
      const targetCard = {
        ...activeCard,
        ...(nextPending.agentId ? { agentId: nextPending.agentId } : {}),
        messageId: nextPending.replyToMessageId,
      };
      setScheduleBusy(true);
      setScheduleError("");
      if (draftScope) {
        try {
          await saveDraftAndFlush(
            client?.origin,
            draftScope,
            trimmed || finalPrompt,
            {
              schedule: {
                key: nextPending.idempotencyKey,
                sendAt: nextPending.sendAt,
                input: nextPending.input,
                ...(nextPending.agentId
                  ? { agentId: nextPending.agentId }
                  : {}),
                attachmentIds: nextPending.attachmentIds,
                ...(nextPending.replyToMessageId
                  ? { replyToMessageId: nextPending.replyToMessageId }
                  : {}),
              },
            },
          );
        } catch (persistErr) {
          haptics.warning();
          setScheduleError(
            persistErr instanceof Error
              ? persistErr.message
              : "Could not save schedule recovery state locally.",
          );
          setScheduleBusy(false);
          return;
        }
      }
      setPendingSchedule(nextPending);
      try {
        await onScheduleReply(
          targetCard,
          nextPending.input,
          nextPending.attachmentIds,
          nextPending.idempotencyKey,
          nextPending.sendAt,
        );
        setPendingSchedule(null);
        setScheduleOpen(false);
        pendingReplyRef.current = null;
        setRetryModeLocked(false);
        if (draftScope) clearDraft(client?.origin, draftScope);
        setDraft("");
        clearAttachments();
        Keyboard.dismiss();
      } catch (err) {
        if (err instanceof LoopApiError && err.status === 401) {
          setPendingSchedule(null);
          setScheduleBusy(false);
          return;
        }
        if (isUncertainOutcomeError(err)) {
          setPendingSchedule({ ...nextPending, locked: true });
        } else if (
          err instanceof LoopApiError &&
          err.status === 409 &&
          nextPending.locked
        ) {
          setPendingSchedule({ ...nextPending, locked: true });
          haptics.warning();
          setScheduleError(
            "This scheduled message may already exist — check Profile → Scheduled before unlocking.",
          );
          return;
        } else {
          setPendingSchedule(null);
          if (draftScope) {
            if (draft.trim()) saveDraft(client?.origin, draftScope, draft);
            else clearDraft(client?.origin, draftScope);
          }
        }
        haptics.warning();
        setScheduleError(
          err instanceof Error
            ? err.message
            : "Could not schedule reply. Try again.",
        );
      } finally {
        setScheduleBusy(false);
      }
    },
    [
      activeCard,
      client?.origin,
      draft,
      draftScope,
      onScheduleReply,
      pendingSchedule,
      replyAttachments,
      scheduleBusy,
      sending,
    ],
  );

  const handleSelectNeighbor = useCallback(
    (idx: number) => {
      haptics.light();
      scrollToSlide(idx, true);
    },
    [scrollToSlide],
  );

  const handleLongPressCard = useCallback((card: NativeResultCard) => {
    haptics.medium();
    setActionSheetCard(card);
  }, []);

  const handlePullToSearch = useCallback(() => {
    openSearch();
  }, [openSearch]);

  // Hold repinning while the composer is active.
  useEffect(() => {
    const top = recentCards[0]?.id;
    if (holdHistoryUpdates || !top || lastTopCardRef.current === top) return;
    lastTopCardRef.current = top;
    if (pinnedIds.includes(top)) return;
    haptics.light();
    const nextPinned = openingCarouselCardIds(
      cards,
      recentCards,
      openingCard,
      false,
    );
    const newest = cardsById.get(nextPinned[0]);
    setPinnedIds(nextPinned);
    setSelection({ index: 0, key: newest && carouselCardKey(newest) });
    lastCenteredIdx.value = 0;
    scrollRef.current?.scrollTo({ x: 0, y: 0, animated: true });
  }, [
    cards,
    cardsById,
    holdHistoryUpdates,
    lastCenteredIdx,
    openingCard,
    pinnedIds,
    recentCards,
  ]);

  const actionSavedEdit =
    actionSheetCard && savedEdits.get(carouselCardKey(actionSheetCard));
  const actionSaved =
    actionSavedEdit?.saved ??
    (actionSheetCard?.messageId && serverSavedIds
      ? serverSavedIds.has(actionSheetCard.messageId)
      : actionSheetCard?.saved);
  const actionSavePending = Boolean(
    actionSavedEdit?.pending || actionSavedEdit?.uncertain,
  );

  if (!slides.length) return null;

  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 30 }]}
      pointerEvents="box-none"
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h > 0 && Math.abs(h - stageHeight) >= 1) {
          setStageHeight(h);
        }
      }}
    >
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
                  placeholder="Search loaded cards…"
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
                      {historyNextCursor ? "+" : ""}
                    </Text>
                  </Pressable>
                  {(historyNextCursor || historyUnavailable) && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        historyUnavailable
                          ? "Retry loading conversation history"
                          : "Load earlier cards in thread"
                      }
                      disabled={loadingMoreHistory}
                      onPress={() => {
                        haptics.light();
                        if (historyUnavailable) setHistoryRetry(randomUuid());
                        else void loadMoreHistory();
                      }}
                      style={({ pressed }) => [
                        styles.loadMorePill,
                        {
                          backgroundColor: pressed
                            ? theme.attention
                            : theme.pillBg,
                          borderColor: theme.line,
                          opacity: loadingMoreHistory ? 0.6 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.loadMorePillText,
                          { color: theme.brassText },
                        ]}
                      >
                        {loadingMoreHistory
                          ? "…"
                          : historyUnavailable
                            ? "Retry history"
                            : "+Older"}
                      </Text>
                    </Pressable>
                  )}

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

          {/* Live Run Activity & Controls Banner */}
          {!searchOpen && activeRun && (
            <View style={styles.statusBannerWrap}>
              <View
                style={[
                  styles.runControlBanner,
                  {
                    backgroundColor:
                      activeRun.state === "failed" ||
                      activeRun.state === "interrupted"
                        ? theme.orangeSoft
                        : theme.pillBg,
                    borderColor:
                      activeRun.state === "failed" ||
                      activeRun.state === "interrupted"
                        ? theme.orange
                        : theme.line,
                  },
                ]}
              >
                <Sparkles
                  size={13}
                  color={
                    activeRun.state === "failed" ||
                    activeRun.state === "interrupted"
                      ? theme.orange
                      : theme.blue
                  }
                />
                <Text
                  style={[
                    styles.statusBannerText,
                    {
                      color:
                        activeRun.state === "failed" ||
                        activeRun.state === "interrupted"
                          ? theme.orange
                          : theme.text,
                      flexShrink: 1,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {liveStream?.activity ||
                    (activeRun.state === "paused"
                      ? "Paused"
                      : activeRun.state === "pausing"
                        ? "Pausing…"
                        : activeRun.state === "failed"
                          ? "Run failed"
                          : activeRun.state === "interrupted"
                            ? "Run interrupted"
                            : activeRun.state === "awaiting_approval"
                              ? "Needs approval"
                              : `@${agentName} is working…`)}
                </Text>

                {onControlRun && (
                  <View style={styles.runControlActions}>
                    {canPause &&
                      (activeRun.state === "running" ||
                        activeRun.state === "waiting_children") && (
                        <Pressable
                          accessibilityLabel="Pause run"
                          onPress={() => {
                            haptics.light();
                            onControlRun(activeRun.id, "pause");
                          }}
                          style={[
                            styles.runCtrlBtn,
                            {
                              backgroundColor: theme.soft,
                              borderColor: theme.line,
                            },
                          ]}
                        >
                          <Pause size={12} color={theme.text} />
                          <Text
                            style={[styles.runCtrlText, { color: theme.text }]}
                          >
                            Pause
                          </Text>
                        </Pressable>
                      )}
                    {activeRun.state === "paused" && (
                      <Pressable
                        accessibilityLabel="Resume run"
                        onPress={() => {
                          haptics.light();
                          onControlRun(activeRun.id, "resume");
                        }}
                        style={[
                          styles.runCtrlBtn,
                          {
                            backgroundColor: theme.attention,
                            borderColor: theme.attentionLine,
                          },
                        ]}
                      >
                        <Play size={12} color={theme.brassText} />
                        <Text
                          style={[
                            styles.runCtrlText,
                            { color: theme.brassText },
                          ]}
                        >
                          Resume
                        </Text>
                      </Pressable>
                    )}
                    {(activeRun.state === "failed" ||
                      activeRun.state === "interrupted") && (
                      <Pressable
                        accessibilityLabel="Retry run"
                        onPress={() => {
                          haptics.medium();
                          onControlRun(activeRun.id, "retry");
                        }}
                        style={[
                          styles.runCtrlBtn,
                          {
                            backgroundColor: theme.attention,
                            borderColor: theme.attentionLine,
                          },
                        ]}
                      >
                        <RotateCcw size={12} color={theme.brassText} />
                        <Text
                          style={[
                            styles.runCtrlText,
                            { color: theme.brassText },
                          ]}
                        >
                          Retry
                        </Text>
                      </Pressable>
                    )}
                    {(activeRun.state === "running" ||
                      activeRun.state === "pausing" ||
                      activeRun.state === "paused" ||
                      activeRun.state === "waiting_children") && (
                      <Pressable
                        accessibilityLabel="Stop run"
                        onPress={() => {
                          haptics.warning();
                          onControlRun(activeRun.id, "cancel");
                        }}
                        style={[
                          styles.runCtrlBtn,
                          {
                            backgroundColor: theme.orangeSoft,
                            borderColor: theme.orange,
                          },
                        ]}
                      >
                        <Square size={11} color={theme.orange} />
                        <Text
                          style={[styles.runCtrlText, { color: theme.orange }]}
                        >
                          Stop
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            </View>
          )}

          {!searchOpen && queuedRuns.length > 0 && (
            <View style={styles.statusBannerWrap}>
              <Pressable
                onPress={() => {
                  haptics.light();
                  setQueuedSheetOpen(true);
                }}
                style={({ pressed }) => [
                  styles.statusBannerPill,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Clock size={13} color={theme.brassText} />
                <Text
                  style={[styles.statusBannerText, { color: theme.brassText }]}
                >
                  {queuedRuns.length}{" "}
                  {queuedRuns.length === 1 ? "message" : "messages"} queued for
                  @{agentName}
                </Text>
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
            <PagerLock.Provider value={setPagerLocked}>
              <Animated.ScrollView
                ref={scrollRef}
                horizontal
                scrollEnabled={!pagerLocked}
                // With the reply keyboard up, the default ("never") makes this
                // carousel claim every touch to dismiss the keyboard, so the
                // card underneath cannot scroll. Let the card take the touch.
                keyboardShouldPersistTaps="handled"
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
                  // Window rendering: only mount rich card trees for the active card
                  // and its immediate left/right peeking neighbors (at most 3 cards).
                  if (Math.abs(index - safeIndex) > 1) {
                    return (
                      <View
                        key={slide.id}
                        style={[
                          styles.floatCard,
                          {
                            width: cardWidth,
                            backgroundColor: theme.surface,
                            borderColor: theme.line,
                            opacity: 0.62,
                          },
                        ]}
                      />
                    );
                  }
                  const header = headers[index];
                  const isMatch =
                    Boolean(
                      (searchOpen ? searchQuery : committedQuery).trim(),
                    ) && activeHits.some((h) => h.index === index);
                  const slideFiles =
                    (slide.runId && runFilesByRunId.get(slide.runId)) ||
                    EMPTY_PUBLISHED_FILES;
                  return (
                    <FloatingCarouselCard
                      key={slide.id}
                      slide={slide}
                      header={header}
                      files={slideFiles}
                      client={client}
                      index={index}
                      isActive={index === safeIndex}
                      isMatch={isMatch}
                      cardWidth={cardWidth}
                      snapInterval={snapInterval}
                      scrollX={scrollX}
                      theme={theme}
                      onSelectNeighbor={handleSelectNeighbor}
                      onPullToSearch={handlePullToSearch}
                      onLongPress={handleLongPressCard}
                      onReplyButton={prefillReply}
                      onOpenFile={onOpenFile}
                      onOpenFileTarget={onOpenFileTarget}
                    />
                  );
                })}
              </Animated.ScrollView>
            </PagerLock.Provider>
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
                        ? "No matches in loaded cards"
                        : `${liveHits.length} ${liveHits.length === 1 ? "match" : "matches"} in ${slides.length} loaded cards`}
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
                  Search the {slides.length} loaded{" "}
                  {slides.length === 1 ? "card" : "cards"}.
                </Text>
              )}
              {historyNextCursor && (
                <Pressable
                  accessibilityRole="button"
                  disabled={loadingMoreHistory}
                  onPress={() => void loadMoreHistory()}
                >
                  <Text
                    style={[styles.searchEmptyHint, { color: theme.brassText }]}
                  >
                    {loadingMoreHistory
                      ? "Loading older cards…"
                      : "Load older cards to search them"}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* Sliding-Window Tactile Dot Rail */}
          {slides.length > 1 && !keyboardVisible && (
            <CarouselDotRail
              total={slides.length}
              activeIndex={safeIndex}
              committedQuery={committedQuery}
              hitIndexes={committedHits.map((h) => h.index)}
              theme={theme}
              onSelect={(index) => {
                haptics.selection();
                scrollToSlide(index, true);
              }}
            />
          )}

          {sending && (
            <View style={styles.replyFloatWrap}>
              <View
                accessibilityLiveRegion="polite"
                style={[
                  styles.replyPill,
                  styles.pendingReply,
                  { backgroundColor: theme.pillBg, borderColor: theme.line },
                ]}
              >
                <ActivityIndicator size="small" color={theme.brassText} />
                <Text style={[styles.statusBannerText, { color: theme.text }]}>
                  Sending reply…
                </Text>
              </View>
            </View>
          )}

          {/* Detached Floating Reply Pill along the bottom */}
          <View
            style={[styles.replyFloatWrap, sending && styles.hiddenComposer]}
          >
            {canSteerActiveRun && (
              <View style={styles.deliveryModeRow}>
                <Pressable
                  disabled={sending || retryModeLocked}
                  onPress={() => {
                    haptics.selection();
                    setDeliveryMode("steer");
                  }}
                  style={[
                    styles.deliveryChip,
                    {
                      backgroundColor:
                        deliveryMode === "steer"
                          ? theme.attention
                          : theme.pillBg,
                      borderColor:
                        deliveryMode === "steer"
                          ? theme.attentionLine
                          : theme.line,
                      opacity: sending || retryModeLocked ? 0.55 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.deliveryChipText,
                      {
                        color:
                          deliveryMode === "steer"
                            ? theme.brassText
                            : theme.muted,
                      },
                    ]}
                  >
                    Steer live run
                  </Text>
                </Pressable>
                <Pressable
                  disabled={sending || retryModeLocked}
                  onPress={() => {
                    haptics.selection();
                    setDeliveryMode("queue");
                  }}
                  style={[
                    styles.deliveryChip,
                    {
                      backgroundColor:
                        deliveryMode === "queue"
                          ? theme.attention
                          : theme.pillBg,
                      borderColor:
                        deliveryMode === "queue"
                          ? theme.attentionLine
                          : theme.line,
                      opacity: sending || retryModeLocked ? 0.55 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.deliveryChipText,
                      {
                        color:
                          deliveryMode === "queue"
                            ? theme.brassText
                            : theme.muted,
                      },
                    ]}
                  >
                    Queue after run
                  </Text>
                </Pressable>
              </View>
            )}
            {replyError ? (
              <Text
                style={[styles.replyErrorText, { color: theme.orange }]}
                numberOfLines={2}
              >
                {replyError}
              </Text>
            ) : null}
            <AttachmentChipStrip
              attachments={replyAttachments.attachments}
              theme={theme}
              locked={scheduleLocked}
              onRemove={replyAttachments.removeAttachment}
              onRetry={(id) => void replyAttachments.retryAttachment(id)}
            />
            <View
              style={[
                styles.replyPill,
                {
                  backgroundColor: theme.pillBg,
                  borderColor: theme.line,
                },
              ]}
            >
              <Pressable
                accessibilityLabel="Attach photo or file"
                disabled={
                  !replyAttachments.canAddMore ||
                  sending ||
                  scheduleBusy ||
                  scheduleLocked
                }
                onPress={() => {
                  haptics.light();
                  Keyboard.dismiss();
                  replyAttachments.setPickerOpen(true);
                }}
                style={[
                  styles.replyQuickBtn,
                  (!replyAttachments.canAddMore ||
                    sending ||
                    scheduleBusy ||
                    scheduleLocked) && {
                    opacity: 0.4,
                  },
                ]}
              >
                <Paperclip
                  size={16}
                  color={
                    replyAttachments.attachments.length > 0
                      ? theme.brassText
                      : theme.muted
                  }
                />
              </Pressable>
              <VoiceRecorderButton
                theme={theme}
                disabled={
                  !replyAttachments.canAddMore ||
                  sending ||
                  scheduleBusy ||
                  scheduleLocked
                }
                onRecordingChange={setRecordingAudio}
                onRecorded={(file) => {
                  setReplyError("");
                  void replyAttachments.addFiles([file]);
                }}
                onError={(msg) => setReplyError(msg)}
              />
              <Pressable
                accessibilityLabel="Quick replies and snippets"
                disabled={scheduleLocked}
                onPress={() => {
                  haptics.light();
                  setQuickReplyOpen(true);
                }}
                style={[
                  styles.replyQuickBtn,
                  scheduleLocked && { opacity: 0.4 },
                ]}
              >
                <Zap size={16} color={theme.brassText} />
              </Pressable>
              <TextInput
                ref={replyInputRef}
                value={draft}
                editable={!sending && !scheduleBusy && !scheduleLocked}
                onChangeText={(next) => {
                  draftTouchedRef.current = true;
                  pendingReplyRef.current = null;
                  if (replyError) setReplyError("");
                  setDraft(next);
                  if (draftScope) saveDraft(client?.origin, draftScope, next);
                }}
                placeholder={`Reply to @${agentName}…`}
                placeholderTextColor={theme.muted}
                style={[styles.replyInput, { color: theme.text }]}
                multiline
                maxLength={1200}
                returnKeyType="default"
              />
              {client && onScheduleReply && activeCard && (
                <Pressable
                  accessibilityLabel="Schedule reply"
                  disabled={
                    (!draft.trim() &&
                      replyAttachments.readyIds.length === 0 &&
                      !pendingSchedule) ||
                    replyAttachments.uploading ||
                    (replyAttachments.hasErrors && !pendingSchedule) ||
                    recordingAudio ||
                    sending ||
                    scheduleBusy ||
                    retryModeLocked
                  }
                  onPress={() => {
                    haptics.light();
                    Keyboard.dismiss();
                    setScheduleError("");
                    setScheduleOpen(true);
                  }}
                  style={[
                    styles.replyOpenThreadBtn,
                    ((!draft.trim() &&
                      replyAttachments.readyIds.length === 0 &&
                      !pendingSchedule) ||
                      replyAttachments.uploading ||
                      (replyAttachments.hasErrors && !pendingSchedule) ||
                      recordingAudio ||
                      sending ||
                      scheduleBusy ||
                      retryModeLocked) && { opacity: 0.35 },
                  ]}
                >
                  <Clock
                    size={16}
                    color={pendingSchedule ? theme.brassText : theme.muted}
                  />
                </Pressable>
              )}
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
                disabled={
                  (!draft.trim() && replyAttachments.readyIds.length === 0) ||
                  replyAttachments.uploading ||
                  replyAttachments.hasErrors ||
                  recordingAudio ||
                  sending ||
                  scheduleBusy ||
                  Boolean(pendingSchedule)
                }
                onPress={() => void submitReply()}
                style={({ pressed }) => [
                  styles.replySendBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity:
                      (!draft.trim() &&
                        replyAttachments.readyIds.length === 0) ||
                      replyAttachments.uploading ||
                      replyAttachments.hasErrors ||
                      recordingAudio ||
                      sending ||
                      scheduleBusy ||
                      Boolean(pendingSchedule)
                        ? 0.36
                        : pressed
                          ? 0.85
                          : 1,
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

      <AttachmentSourceSheet
        visible={replyAttachments.pickerOpen}
        theme={theme}
        onClose={() => replyAttachments.setPickerOpen(false)}
        onPickPhotos={() => void replyAttachments.pickFromPhotos()}
        onTakePhoto={() => void replyAttachments.takePhoto()}
        onPickFile={() => void replyAttachments.pickDocument()}
      />

      <ScheduleSendSheet
        visible={scheduleOpen}
        theme={theme}
        agentName={agentName}
        previewText={draft}
        attachmentCount={
          pendingSchedule
            ? pendingSchedule.attachmentIds.length
            : replyAttachments.readyIds.length
        }
        busy={scheduleBusy}
        error={scheduleError}
        lockedSendAt={pendingSchedule?.locked ? pendingSchedule.sendAt : null}
        onClose={() => setScheduleOpen(false)}
        onConfirm={(sendAt) => void submitScheduledReply(sendAt)}
        onDiscardPending={() => {
          setPendingSchedule(null);
          setScheduleError("");
          setScheduleOpen(false);
          if (draftScope) {
            if (draft.trim()) saveDraft(client?.origin, draftScope, draft);
            else clearDraft(client?.origin, draftScope);
          }
        }}
      />

      {/* Queued Messages Sheet for this agent */}
      <Modal
        visible={queuedSheetOpen && queuedRuns.length > 0}
        transparent
        animationType="fade"
        onRequestClose={() => setQueuedSheetOpen(false)}
      >
        <Pressable
          style={[
            styles.actionModalBackdrop,
            { backgroundColor: "rgba(0,0,0,0.48)" },
          ]}
          onPress={() => setQueuedSheetOpen(false)}
        >
          <Pressable
            onPress={() => {}}
            style={[
              styles.quickSheet,
              {
                backgroundColor: theme.surface,
                borderColor: theme.line,
                paddingBottom: Math.max(insets.bottom + 14, 22),
              },
            ]}
          >
            <View style={styles.quickSheetHead}>
              <View style={styles.actionHeadMeta}>
                <Text style={[styles.quickSheetTitle, { color: theme.text }]}>
                  Queued for @{agentName}
                </Text>
                <Text style={[styles.actionHeadSub, { color: theme.muted }]}>
                  {queuedRuns.length}{" "}
                  {queuedRuns.length === 1 ? "message" : "messages"} waiting to
                  run
                </Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  haptics.light();
                  setQueuedSheetOpen(false);
                }}
              >
                <X size={18} color={theme.muted} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 320 }}>
              <View style={{ gap: 8 }}>
                {queuedRuns.map((run, idx) => (
                  <View
                    key={run.id}
                    style={[
                      styles.quickOption,
                      {
                        backgroundColor: theme.soft,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.hitIndex,
                        { color: theme.brassText, marginTop: 1 },
                      ]}
                    >
                      #{idx + 1}
                    </Text>
                    <View style={styles.quickOptionText}>
                      <Text
                        style={[styles.quickOptionLabel, { color: theme.text }]}
                        numberOfLines={3}
                      >
                        {run.input || "Queued task"}
                      </Text>
                      <Text
                        style={[styles.quickOptionHint, { color: theme.muted }]}
                        numberOfLines={1}
                      >
                        {run.threadTitle
                          ? `${run.threadTitle} · ${relativeTime(run.created_at)}`
                          : `Queued ${relativeTime(run.created_at)}`}
                      </Text>
                    </View>
                    <View style={styles.queuedActions}>
                      {onReorderQueuedRun &&
                        (run.can_move_up || run.can_move_down) && (
                          <>
                            <Pressable
                              accessibilityLabel="Move queued message up"
                              disabled={!run.can_move_up}
                              hitSlop={6}
                              onPress={() => {
                                haptics.selection();
                                onReorderQueuedRun(run.id, "up");
                              }}
                              style={[
                                styles.controlsCollapseBtn,
                                {
                                  backgroundColor: theme.raised,
                                  borderColor: theme.line,
                                  opacity: run.can_move_up ? 1 : 0.35,
                                },
                              ]}
                            >
                              <ChevronUp size={14} color={theme.text} />
                            </Pressable>
                            <Pressable
                              accessibilityLabel="Move queued message down"
                              disabled={!run.can_move_down}
                              hitSlop={6}
                              onPress={() => {
                                haptics.selection();
                                onReorderQueuedRun(run.id, "down");
                              }}
                              style={[
                                styles.controlsCollapseBtn,
                                {
                                  backgroundColor: theme.raised,
                                  borderColor: theme.line,
                                  opacity: run.can_move_down ? 1 : 0.35,
                                },
                              ]}
                            >
                              <ChevronDown size={14} color={theme.text} />
                            </Pressable>
                          </>
                        )}
                      {onCancelQueuedRun && (
                        <Pressable
                          accessibilityLabel="Cancel queued message"
                          hitSlop={8}
                          onPress={() => {
                            haptics.warning();
                            onCancelQueuedRun(run.id);
                            if (queuedRuns.length <= 1) {
                              setQueuedSheetOpen(false);
                            }
                          }}
                          style={[
                            styles.controlsCollapseBtn,
                            {
                              backgroundColor: theme.raised,
                              borderColor: theme.line,
                            },
                          ]}
                        >
                          <X size={14} color={theme.muted} />
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Long-press Card Actions Sheet (Save, Remind, Reply, Mark Done, Open Thread) */}
      <Modal
        visible={Boolean(actionSheetCard)}
        transparent
        animationType="fade"
        onRequestClose={() => setActionSheetCard(null)}
      >
        <Pressable
          style={[
            styles.actionModalBackdrop,
            { backgroundColor: "rgba(0,0,0,0.48)" },
          ]}
          onPress={() => setActionSheetCard(null)}
        >
          {actionSheetCard && (
            <Pressable
              onPress={() => {}}
              style={[
                styles.quickSheet,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.line,
                  paddingBottom: Math.max(insets.bottom + 14, 22),
                },
              ]}
            >
              <View style={styles.quickSheetHead}>
                <View style={styles.actionHeadMeta}>
                  <Text
                    style={[styles.quickSheetTitle, { color: theme.text }]}
                    numberOfLines={1}
                  >
                    {actionSheetCard.fallbackTitle ||
                      `@${actionSheetCard.agentName}`}
                  </Text>
                  <Text style={[styles.actionHeadSub, { color: theme.muted }]}>
                    @{actionSheetCard.agentName} ·{" "}
                    {relativeTime(actionSheetCard.createdAt)}
                  </Text>
                </View>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    haptics.light();
                    setActionSheetCard(null);
                  }}
                >
                  <X size={18} color={theme.muted} />
                </Pressable>
              </View>

              <Pressable
                onPress={() => {
                  const target = actionSheetCard;
                  setActionSheetCard(null);
                  haptics.success();
                  const resolveAndCopy = async () => {
                    let bodyToCopy =
                      (target.messageId && fullBodies.get(target.messageId)) ||
                      target.body;
                    if (
                      target.bodyTruncated &&
                      client &&
                      target.messageId &&
                      !fullBodies.has(target.messageId)
                    ) {
                      try {
                        const detail = await client.messageDetail(
                          target.messageId,
                        );
                        if (detail.content) bodyToCopy = detail.content;
                      } catch {
                        // Fall back to visible body if detail fetch fails
                      }
                    }
                    await Clipboard.setStringAsync(bodyToCopy);
                    onNotify?.("Copied answer");
                  };
                  void resolveAndCopy().catch(() => {});
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: theme.line,
                  },
                ]}
              >
                <Copy size={18} color={theme.brassText} />
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    Copy answer
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                  >
                    Copy the full response text to your clipboard
                  </Text>
                </View>
              </Pressable>

              <Pressable
                disabled={actionSavePending}
                onPress={() => {
                  const target = {
                    ...actionSheetCard,
                    saved: Boolean(actionSaved),
                  };
                  setActionSheetCard(null);
                  haptics.medium();
                  handleSlideToggleSaved(target);
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: actionSaved ? theme.attentionLine : theme.line,
                  },
                ]}
              >
                {actionSaved ? (
                  <BookmarkCheck size={18} color={theme.brassText} />
                ) : (
                  <Bookmark size={18} color={theme.brassText} />
                )}
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    {actionSavePending
                      ? "Checking Saved…"
                      : actionSaved
                        ? "Remove from Saved"
                        : "Save card"}
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                  >
                    {actionSaved
                      ? "Unbookmark this answer"
                      : "Keep this answer in your Saved library"}
                  </Text>
                </View>
              </Pressable>

              <Pressable
                onPress={() => {
                  const target = actionSheetCard;
                  setActionSheetCard(null);
                  haptics.light();
                  onRemind(target);
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: theme.line,
                  },
                ]}
              >
                <AlarmClock size={18} color={theme.brassText} />
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    Remind me…
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                  >
                    Bring this card back later or when a run finishes
                  </Text>
                </View>
              </Pressable>

              <Pressable
                onPress={() => {
                  setActionSheetCard(null);
                  focusReplyInput();
                }}
                style={({ pressed }) => [
                  styles.quickOption,
                  {
                    backgroundColor: pressed ? theme.attention : theme.soft,
                    borderColor: theme.line,
                  },
                ]}
              >
                <CornerUpLeft size={18} color={theme.text} />
                <View style={styles.quickOptionText}>
                  <Text
                    style={[styles.quickOptionLabel, { color: theme.text }]}
                  >
                    Reply to @{actionSheetCard.agentName}
                  </Text>
                  <Text
                    style={[styles.quickOptionHint, { color: theme.muted }]}
                  >
                    Open reply bar and carousel controls
                  </Text>
                </View>
              </Pressable>

              {(Boolean(actionSheetCard.doneCardKey) ||
                Boolean(actionSheetCard.replyCardKey) ||
                !client) && (
                <Pressable
                  onPress={() => {
                    const target = actionSheetCard;
                    setActionSheetCard(null);
                    haptics.success();
                    onDismissCard(target);
                  }}
                  style={({ pressed }) => [
                    styles.quickOption,
                    {
                      backgroundColor: pressed ? theme.greenSoft : theme.soft,
                      borderColor: theme.line,
                    },
                  ]}
                >
                  <Check size={18} color={theme.green} />
                  <View style={styles.quickOptionText}>
                    <Text
                      style={[styles.quickOptionLabel, { color: theme.text }]}
                    >
                      Mark done
                    </Text>
                    <Text
                      style={[styles.quickOptionHint, { color: theme.muted }]}
                    >
                      Clear this card from Done
                    </Text>
                  </View>
                </Pressable>
              )}

              {onOpenThread && (
                <Pressable
                  onPress={() => {
                    const target = actionSheetCard;
                    setActionSheetCard(null);
                    haptics.light();
                    onOpenThread(target);
                  }}
                  style={({ pressed }) => [
                    styles.quickOption,
                    {
                      backgroundColor: pressed ? theme.raised : theme.soft,
                      borderColor: theme.line,
                    },
                  ]}
                >
                  <ArrowUpRight size={18} color={theme.muted} />
                  <View style={styles.quickOptionText}>
                    <Text
                      style={[styles.quickOptionLabel, { color: theme.text }]}
                    >
                      Open full thread
                    </Text>
                    <Text
                      style={[styles.quickOptionHint, { color: theme.muted }]}
                    >
                      View complete chronological conversation
                    </Text>
                  </View>
                </Pressable>
              )}
            </Pressable>
          )}
        </Pressable>
      </Modal>

      {/* Frosted Quick Reply Sheet */}
      {quickReplyOpen &&
        (() => {
          const quickSheetLayout = computeQuickSheetLayout({
            windowHeight: effectiveStageHeight,
            insetTop: insets.top,
            insetBottom: insets.bottom,
            keyboardInset,
          });
          return (
            <View
              style={[
                StyleSheet.absoluteFill,
                styles.quickSheetOverlay,
                { paddingBottom: keyboardInset },
              ]}
            >
              <Pressable
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: "rgba(0,0,0,0.45)" },
                ]}
                onPress={() => setQuickReplyOpen(false)}
              />
              <View
                style={[
                  styles.quickSheet,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                    maxHeight: quickSheetLayout.maxSheetHeight,
                    paddingBottom: quickSheetLayout.sheetPaddingBottom,
                  },
                ]}
              >
                <View style={styles.quickSheetHead}>
                  <Text style={[styles.quickSheetTitle, { color: theme.text }]}>
                    Quick reply
                  </Text>
                  <Pressable
                    accessibilityLabel="Close quick reply"
                    onPress={() => {
                      haptics.light();
                      setQuickReplyOpen(false);
                    }}
                  >
                    <X size={18} color={theme.muted} />
                  </Pressable>
                </View>
                <ScrollView
                  style={[
                    styles.quickSheetScroll,
                    { maxHeight: quickSheetLayout.maxScrollHeight },
                  ]}
                  contentContainerStyle={styles.quickSheetList}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                  bounces
                >
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
                          backgroundColor: pressed
                            ? theme.attention
                            : theme.soft,
                          borderColor: pressed
                            ? theme.attentionLine
                            : theme.line,
                        },
                      ]}
                    >
                      <Zap size={16} color={theme.brassText} />
                      <View style={styles.quickOptionText}>
                        <Text
                          style={[
                            styles.quickOptionLabel,
                            { color: theme.text },
                          ]}
                        >
                          {opt.label}
                        </Text>
                        <Text
                          style={[
                            styles.quickOptionHint,
                            { color: theme.muted },
                          ]}
                        >
                          {opt.hint}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                  {snippets.map((snip) => (
                    <Pressable
                      key={snip.id}
                      onPress={() => {
                        haptics.light();
                        prefillReply(snip.content);
                      }}
                      style={({ pressed }) => [
                        styles.quickOption,
                        {
                          backgroundColor: pressed
                            ? theme.attention
                            : theme.soft,
                          borderColor: pressed
                            ? theme.attentionLine
                            : theme.line,
                        },
                      ]}
                    >
                      <Sparkles size={16} color={theme.brassText} />
                      <View style={styles.quickOptionText}>
                        <Text
                          style={[
                            styles.quickOptionLabel,
                            { color: theme.text },
                          ]}
                        >
                          /{snip.title}
                        </Text>
                        <Text
                          style={[
                            styles.quickOptionHint,
                            { color: theme.muted },
                          ]}
                          numberOfLines={1}
                        >
                          {snip.content}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            </View>
          );
        })()}
    </View>
  );
}

const FloatingCarouselCard = React.memo(function FloatingCarouselCard({
  slide,
  header,
  files,
  client,
  index,
  isActive,
  isMatch,
  cardWidth,
  snapInterval,
  scrollX,
  theme,
  onSelectNeighbor,
  onPullToSearch,
  onLongPress,
  onReplyButton,
  onOpenFile,
  onOpenFileTarget,
}: {
  slide: NativeResultCard;
  header: ReturnType<typeof resolveCarouselCardHeader>;
  files: PublishedFileItem[];
  client?: LoopClient | null;
  index: number;
  isActive: boolean;
  isMatch: boolean;
  cardWidth: number;
  snapInterval: number;
  scrollX: SharedValue<number>;
  theme: LoopTheme;
  onSelectNeighbor: (index: number) => void;
  onPullToSearch: () => void;
  onLongPress: (card: NativeResultCard) => void;
  onReplyButton: (prompt: string) => void;
  onOpenFile?: (file: PublishedFileItem) => void;
  onOpenFileTarget?: (target: LoopFileTarget, label?: string) => void;
}) {
  const [pullHint, setPullHint] = useState<"idle" | "pulling" | "ready">(
    "idle",
  );
  const pullArmedRef = useRef(false);
  const dragStartAtTopRef = useRef(false);
  const lastPullYRef = useRef(0);

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
          onPress={() => onSelectNeighbor(index)}
        />
      )}

      {/* Card Eyebrow (never crowds the title) */}
      <Pressable
        delayLongPress={420}
        onLongPress={isActive ? () => onLongPress(slide) : undefined}
        style={styles.cardEyebrow}
      >
        <View style={styles.cardBadges}>
          {(slide.tab === "working" || slide.statusLabel === "Working") && (
            <View
              style={[
                styles.badgeSaved,
                {
                  backgroundColor: theme.blueSoft,
                  borderColor: theme.blue,
                },
              ]}
            >
              <Sparkles size={11} color={theme.blue} />
              <Text style={[styles.badgeSavedText, { color: theme.blue }]}>
                Working
              </Text>
            </View>
          )}
          {slide.saved && (
            <View
              style={[
                styles.badgeSaved,
                {
                  backgroundColor: theme.roseSoft,
                  borderColor: theme.rose,
                },
              ]}
            >
              <BookmarkCheck size={12} color={theme.rose} />
              <Text style={[styles.badgeSavedText, { color: theme.rose }]}>
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
          {runModelLabel(slide.model)}
        </Text>
      </Pressable>

      {/* Pull-down-to-search tactile indicator */}
      {pullHint !== "idle" && (
        <View style={styles.pullSearchBar}>
          <View
            style={[
              styles.pullSearchPill,
              {
                backgroundColor:
                  pullHint === "ready" ? theme.attention : theme.soft,
                borderColor: pullHint === "ready" ? theme.brass : theme.line,
              },
            ]}
          >
            <Search
              size={12}
              color={pullHint === "ready" ? theme.brassText : theme.muted}
            />
            <Text
              style={[
                styles.pullSearchText,
                {
                  color: pullHint === "ready" ? theme.brassText : theme.muted,
                },
              ]}
            >
              {pullHint === "ready"
                ? "Release to search thread"
                : "Pull down to search…"}
            </Text>
          </View>
        </View>
      )}

      {/* Scrollable Card Body: pull down at top to search, long-press for Save/Remind */}
      <ScrollView
        style={styles.cardScroll}
        contentContainerStyle={styles.cardScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces
        alwaysBounceVertical
        nestedScrollEnabled
        scrollEventThrottle={16}
        onScrollBeginDrag={(e) => {
          dragStartAtTopRef.current = e.nativeEvent.contentOffset.y <= 8;
          pullArmedRef.current = false;
        }}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          lastPullYRef.current = y;
          if (dragStartAtTopRef.current) {
            if (y < -62) {
              if (!pullArmedRef.current) {
                pullArmedRef.current = true;
                haptics.light();
                setPullHint("ready");
              }
            } else if (y < -20) {
              pullArmedRef.current = false;
              if (pullHint !== "pulling") setPullHint("pulling");
            } else if (pullHint !== "idle") {
              pullArmedRef.current = false;
              setPullHint("idle");
            }
          }
        }}
        onScrollEndDrag={() => {
          const shouldSearch =
            dragStartAtTopRef.current &&
            (pullArmedRef.current || lastPullYRef.current < -62);
          dragStartAtTopRef.current = false;
          pullArmedRef.current = false;
          setPullHint("idle");
          if (shouldSearch) {
            onPullToSearch();
          }
        }}
      >
        <Pressable
          delayLongPress={420}
          onLongPress={isActive ? () => onLongPress(slide) : undefined}
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
            content={isActive ? slide.body : slide.body.slice(0, 1200)}
            theme={theme}
            workspaceOrigin={client?.origin}
            onReplyButton={onReplyButton}
            onOpenFile={onOpenFileTarget}
            skipLeadingHeading={
              header.titleSource === "heading" ? header.title : undefined
            }
          />

          {isActive && files.length > 0 && (
            <PublishedFilesStrip
              files={files}
              client={client}
              theme={theme}
              onOpenFile={onOpenFile}
            />
          )}
        </Pressable>
      </ScrollView>
    </Animated.View>
  );
});

function CarouselDotRail({
  total,
  activeIndex,
  committedQuery,
  hitIndexes,
  theme,
  onSelect,
}: {
  total: number;
  activeIndex: number;
  committedQuery: string;
  hitIndexes: number[];
  theme: LoopTheme;
  onSelect: (index: number) => void;
}) {
  const MAX_VISIBLE = 7;
  let start = 0;
  let end = total - 1;
  if (total > MAX_VISIBLE) {
    const half = Math.floor(MAX_VISIBLE / 2);
    start = Math.max(0, Math.min(activeIndex - half, total - MAX_VISIBLE));
    end = start + MAX_VISIBLE - 1;
  }

  const indices: number[] = [];
  for (let i = start; i <= end; i++) indices.push(i);

  const hasMoreLeft = start > 0;
  const hasMoreRight = end < total - 1;

  return (
    <View style={styles.dotsRow}>
      {indices.map((index) => {
        const active = index === activeIndex;
        const isHit = Boolean(committedQuery) && hitIndexes.includes(index);
        const isFarEdge =
          (hasMoreLeft && index === start) || (hasMoreRight && index === end);
        const isNearEdge =
          (hasMoreLeft && index === start + 1) ||
          (hasMoreRight && index === end - 1);
        const dotSize = active ? 7 : isFarEdge ? 4 : isNearEdge ? 5.5 : 7;
        const dotWidth = active ? 22 : dotSize;
        const opacity = active ? 1 : isFarEdge ? 0.4 : isNearEdge ? 0.72 : 1;

        return (
          <Pressable
            key={index}
            hitSlop={8}
            onPress={() => onSelect(index)}
            style={{
              width: dotWidth,
              height: dotSize,
              borderRadius: dotSize / 2,
              opacity,
              backgroundColor: active
                ? theme.brass
                : isHit
                  ? theme.attentionLine
                  : theme.line,
            }}
          />
        );
      })}
      {total > MAX_VISIBLE && (
        <Text style={[styles.dotsCounter, { color: theme.muted }]}>
          {activeIndex + 1}/{total}
        </Text>
      )}
    </View>
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
  runControlBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "94%",
  },
  runControlActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginLeft: 2,
  },
  runCtrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  runCtrlText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  deliveryModeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  deliveryChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  deliveryChipText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  queuedActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
    paddingBottom: 28,
  },
  titleBlock: {
    marginBottom: 12,
    alignItems: "flex-start",
  },
  cardTitle: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  cardTitleCompact: {
    fontSize: 18.5,
    lineHeight: 25,
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
    fontSize: 11.5,
    fontWeight: "700",
  },
  promptQuote: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 14,
    gap: 4,
  },
  promptHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  promptLabel: {
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  promptBody: {
    fontSize: 14.5,
    lineHeight: 21,
  },
  controlsRevealWrap: {
    paddingTop: 2,
  },
  controlsHandleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 4,
    minHeight: 32,
  },
  controlsCollapseBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  controlsSpacer: {
    width: 26,
  },
  bottomEdgeZone: {
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomEdgePill: {
    width: 38,
    height: 4,
    borderRadius: 2,
    opacity: 0.55,
  },
  pullReplyBar: {
    alignItems: "center",
    paddingVertical: 8,
  },
  actionModalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  actionHeadMeta: {
    flex: 1,
    marginRight: 10,
    gap: 2,
  },
  actionHeadSub: {
    fontSize: 12,
    fontWeight: "500",
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
  dotsCounter: {
    marginLeft: 6,
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  pullSearchBar: {
    alignItems: "center",
    paddingBottom: 6,
  },
  pullSearchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  pullSearchText: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  replyQuickBtn: {
    width: 30,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    height: 7,
    borderRadius: 3.5,
  },
  replyFloatWrap: {
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  replyErrorText: {
    fontSize: 12.5,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  hiddenComposer: { display: "none" },
  pendingReply: {
    justifyContent: "center",
    alignItems: "center",
    minHeight: 46,
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
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 10,
  },
  quickSheetScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  quickSheetList: {
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
  loadMorePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  loadMorePillText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
});
