import React, { useCallback, useEffect, useRef, useState } from "react";
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
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  Check,
  Clock,
  Copy,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  TextSelect,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isUncertainOutcomeError,
  LoopApiError,
  randomUuid,
  type LoopClient,
} from "../api/client";
import type { LoopFileTarget, PublishedFileItem } from "../api/files";
import type { LiveStreamOverlay } from "../api/socket";
import type { ApiMessage } from "../api/types";
import {
  clearDraft,
  draftScopeForThread,
  loadDraftEntry,
  saveDraft,
  saveDraftAndFlush,
} from "../drafts";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { ThreadRefreshGate } from "../workspace-runtime";
import { haptics } from "../haptics";
import { CopySessionTracker } from "../text-selection";
import type { LoopTheme } from "../theme";
import type { AgentRunSummary } from "./AgentProfileSheet";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
import { PublishedFilesStrip } from "./FilePreviewModal";
import { AgentAvatar, RichContent } from "./RichContent";
import { ScheduleSendSheet } from "./ScheduleSendSheet";
import { VoiceRecorderButton } from "./VoiceRecorder";

export function ThreadSheet({
  conversationId,
  title,
  agentName,
  agentId,
  client,
  activeRun = null,
  canPause = true,
  liveStream = null,
  fallbackCards,
  refreshKey,
  theme,
  onClose,
  onControlRun,
  onOpenFile,
  onOpenFileTarget,
  onSendLiveReply,
  onScheduleReply,
  onToggleSaved,
}: {
  conversationId: string;
  title: string;
  agentName: string;
  agentId?: string | null;
  client: LoopClient | null;
  activeRun?: AgentRunSummary | null;
  canPause?: boolean;
  liveStream?: LiveStreamOverlay | null;
  fallbackCards?: NativeResultCard[];
  /** Changes when the workspace has new data; the open thread then refreshes in place. */
  refreshKey?: number;
  theme: LoopTheme;
  onClose: () => void;
  onControlRun?: (
    runId: string,
    action: "pause" | "resume" | "cancel" | "retry",
  ) => void;
  onOpenFile?: (file: PublishedFileItem) => void;
  onOpenFileTarget?: (target: LoopFileTarget, label?: string) => void;
  onSendLiveReply: (input: {
    conversationId: string;
    agentId: string;
    agentName: string;
    text: string;
    attachmentIds?: string[];
    idempotencyKey?: string;
    queue?: boolean;
  }) => Promise<void>;
  onScheduleReply?: (input: {
    conversationId: string;
    agentId: string;
    agentName: string;
    text: string;
    attachmentIds?: string[];
    idempotencyKey: string;
    sendAt: number;
  }) => Promise<void>;
  onToggleSaved: (messageId: string, currentlySaved: boolean) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [runFilesByRunId, setRunFilesByRunId] = useState<
    Map<string, PublishedFileItem[]>
  >(() => new Map());
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const bookmarkRevision = useRef(0);
  const pendingBookmarks = useRef(new Set<string>());
  const lastSavedRead = useRef(-Infinity);
  const applyBookmarks = useCallback(
    (saved: string[], revision: number, startedAt: number) => {
      if (
        bookmarkRevision.current !== revision ||
        pendingBookmarks.current.size ||
        startedAt < lastSavedRead.current
      )
        return;
      lastSavedRead.current = startedAt;
      setSavedIds(new Set(saved));
    },
    [],
  );
  const [working, setWorking] = useState(false);
  const [steerableRunId, setSteerableRunId] = useState<string | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<"steer" | "queue">("steer");
  const [retryModeLocked, setRetryModeLocked] = useState(false);
  const [resolvedTitle, setResolvedTitle] = useState(title);
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(
    agentId ?? null,
  );
  const [loading, setLoading] = useState(Boolean(client));
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [selectingMessage, setSelectingMessage] = useState<{
    author: string;
    content: string;
    streamingSnapshot?: boolean;
  } | null>(null);
  const [selectModalCopied, setSelectModalCopied] = useState(false);
  const copyTrackerRef = useRef(new CopySessionTracker());
  const selectCopyTrackerRef = useRef(new CopySessionTracker());

  const openSelectModal = useCallback(
    (author: string, content: string, streamingSnapshot = false) => {
      haptics.light();
      Keyboard.dismiss();
      selectCopyTrackerRef.current.invalidate();
      setSelectModalCopied(false);
      setSelectingMessage({ author, content, streamingSnapshot });
    },
    [],
  );

  const closeSelectModal = useCallback(() => {
    selectCopyTrackerRef.current.invalidate();
    setSelectModalCopied(false);
    setSelectingMessage(null);
  }, []);

  useEffect(() => {
    copyTrackerRef.current.invalidate();
    setCopiedMsgId(null);
    closeSelectModal();
  }, [conversationId, client?.localDataScope, closeSelectModal]);

  useEffect(() => {
    const copyTracker = copyTrackerRef.current;
    const selectTracker = selectCopyTrackerRef.current;
    return () => {
      copyTracker.invalidate();
      selectTracker.invalidate();
    };
  }, []);
  // Suppress auto-scroll-to-bottom briefly after prepending earlier history so multi-pass
  // rich-content layout does not jump the reader back to the bottom.
  const suppressAutoScrollUntilRef = useRef(0);
  const hasLoadedHistoryRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState(false);
  const draftScope = draftScopeForThread(conversationId);
  const draftTouchedRef = useRef(false);
  const restoredPendingRef = useRef<{
    idempotencyKey: string;
    queue?: boolean;
  } | null>(null);
  const restoredPendingScheduleRef = useRef<{
    idempotencyKey: string;
    sendAt: number;
    input: string;
    agentId?: string;
    attachmentIds: string[];
    locked: boolean;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
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
    locked: boolean;
  } | null>(null);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const pendingSendRef = useRef<{
    idempotencyKey: string;
    queue?: boolean;
  } | null>(null);
  const refreshGateRef = useRef(new ThreadRefreshGate());

  useEffect(() => {
    let cancelled = false;
    draftTouchedRef.current = false;
    setDraftLoaded(false);
    setDraftLoadError(false);
    void loadDraftEntry(client?.localDataScope, draftScope)
      .then((entry) => {
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
            locked: true,
          };
          restoredPendingScheduleRef.current = restored;
          setPendingSchedule(restored);
          setDraft(entry.text);
          return;
        }
        if (!draftTouchedRef.current) {
          if (entry.pendingKey) {
            restoredPendingRef.current = {
              idempotencyKey: entry.pendingKey,
              queue: entry.pendingQueue,
            };
            if (entry.pendingQueue !== undefined) {
              setDeliveryMode(entry.pendingQueue ? "queue" : "steer");
            }
          }
          setDraft(entry.text);
        }
      })
      .catch(() => {
        if (!cancelled) setDraftLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client?.localDataScope, draftScope]);

  // The parent rebuilds this array on every render. Read it through a ref so a
  // parent re-render does not reload the thread.
  const fallbackCardsRef = useRef(fallbackCards);
  fallbackCardsRef.current = fallbackCards;
  const replyAttachments = useAttachments(client, {
    agentId: resolvedAgentId,
  });

  // Only offer Steer vs Queue when the server's `steerable_run_id` confirms live input is supported.
  const canSteerActiveRun = Boolean(
    steerableRunId &&
    (working || activeRun?.state === "running") &&
    (!activeRun || activeRun.id === steerableRunId),
  );

  const attSig = replyAttachments.readyIds.join(",");
  useEffect(() => {
    setScheduleError("");
    if (restoredPendingScheduleRef.current) {
      setPendingSchedule(restoredPendingScheduleRef.current);
      restoredPendingScheduleRef.current = null;
    } else {
      setPendingSchedule((prev) => (prev?.locked ? prev : null));
    }
    if (restoredPendingRef.current) {
      pendingSendRef.current = restoredPendingRef.current;
      restoredPendingRef.current = null;
      setRetryModeLocked(true);
      return;
    }
    pendingSendRef.current = null;
    setRetryModeLocked(false);
  }, [draft, conversationId, attSig]);

  const scheduleLocked = Boolean(pendingSchedule?.locked);

  const load = useCallback(async () => {
    if (!client) {
      // Build chronological messages from local demo cards
      const chron = [...(fallbackCardsRef.current ?? [])].reverse();
      const built: ApiMessage[] = [];
      const saved = new Set<string>();
      for (const c of chron) {
        built.push({
          id: `${c.id}:u`,
          conversation_id: c.conversationId,
          run_id: null,
          role: "user",
          content: c.prompt,
          created_at: c.createdAt - 1000,
        });
        built.push({
          id: c.id,
          conversation_id: c.conversationId,
          run_id: null,
          role: "assistant",
          content: c.body,
          created_at: c.createdAt,
        });
        if (c.saved) saved.add(c.id);
      }
      setMessages(built);
      setSavedIds(saved);
      setLoading(false);
      return;
    }

    const gate = refreshGateRef.current;
    const { token, showSpinner } = gate.begin(conversationId);
    if (showSpinner) {
      setLoading(true);
      setError("");
    }
    const bookmarkRead = bookmarkRevision.current;
    const startedAt = performance.now();
    try {
      const page = await client.conversation(conversationId);
      if (!gate.accept(token, conversationId)) return;
      setError("");
      setMessages((prev) => {
        if (!hasLoadedHistoryRef.current || prev.length === 0) {
          return page.messages;
        }
        const incomingIds = new Set(page.messages.map((m) => m.id));
        const oldestIncoming =
          page.messages[0]?.created_at ?? Number.POSITIVE_INFINITY;
        const earlier = prev.filter(
          (m) => !incomingIds.has(m.id) && m.created_at <= oldestIncoming,
        );
        return earlier.length > 0
          ? [...earlier, ...page.messages]
          : page.messages;
      });
      if (!hasLoadedHistoryRef.current) {
        setNextCursor(page.next ?? null);
      }
      applyBookmarks(page.saved, bookmarkRead, startedAt);
      setWorking(page.working);
      setSteerableRunId(page.steerable_run_id ?? null);
      if (page.conversation.title) setResolvedTitle(page.conversation.title);
      if (page.conversation.agent_id) {
        setResolvedAgentId(page.conversation.agent_id);
      }
    } catch (err) {
      if (!gate.showError(token, conversationId)) return;
      setError(
        err instanceof Error ? err.message : "Could not load conversation.",
      );
    } finally {
      if (gate.isLatest(token)) setLoading(false);
    }
  }, [client, conversationId, applyBookmarks]);

  const loadEarlier = useCallback(async () => {
    if (!client || !nextCursor || loadingMore || loading) return;
    const targetConv = conversationId;
    const cursor = nextCursor;
    const bookmarkRead = bookmarkRevision.current;
    const startedAt = performance.now();
    setLoadingMore(true);
    try {
      const page = await client.conversation(targetConv, cursor);
      if (targetConv !== conversationId) return;
      hasLoadedHistoryRef.current = true;
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const older = page.messages.filter((m) => !existingIds.has(m.id));
        if (older.length > 0) {
          suppressAutoScrollUntilRef.current = Date.now() + 800;
          return [...older, ...prev];
        }
        return prev;
      });
      applyBookmarks(page.saved, bookmarkRead, startedAt);
      setNextCursor(page.next ?? null);
    } catch {
      // keep existing messages
    } finally {
      setLoadingMore(false);
    }
  }, [
    client,
    conversationId,
    loading,
    loadingMore,
    nextCursor,
    applyBookmarks,
  ]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Fetch published files for runs present in this thread
  useEffect(() => {
    if (!client) return;
    const runIds = Array.from(
      new Set(
        messages
          .filter((m) => m.role === "assistant" && m.run_id)
          .map((m) => m.run_id!),
      ),
    );
    if (!runIds.length) return;
    let cancelled = false;
    void Promise.all(
      runIds.map(async (runId) => {
        try {
          const files = await client.runFiles(runId);
          return [runId, files] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setRunFilesByRunId((prev) => {
        const next = new Map(prev);
        for (const entry of entries) {
          if (entry) next.set(entry[0], entry[1]);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [client, messages]);

  async function handleSend() {
    const trimmed = draft.trim();
    const { readyIds, readyNames, uploading, hasErrors, clearAttachments } =
      replyAttachments;
    if (
      !draftLoaded ||
      (!trimmed && readyIds.length === 0) ||
      uploading ||
      hasErrors ||
      recordingAudio ||
      sending ||
      scheduleBusy ||
      pendingSchedule
    )
      return;
    const finalText =
      trimmed ||
      (readyNames.length === 1
        ? `Attached ${readyNames[0]}`
        : `Attached ${readyNames.length} files`);
    if (!pendingSendRef.current) {
      pendingSendRef.current = {
        idempotencyKey: randomUuid(),
        queue: canSteerActiveRun ? deliveryMode === "queue" : undefined,
      };
    }
    const { idempotencyKey, queue } = pendingSendRef.current;
    haptics.medium();
    setSending(true);
    setError("");
    try {
      await onSendLiveReply({
        conversationId,
        agentId: resolvedAgentId || "",
        agentName,
        text: finalText,
        attachmentIds: readyIds,
        idempotencyKey,
        ...(queue !== undefined ? { queue } : {}),
      });
      pendingSendRef.current = null;
      setRetryModeLocked(false);
      clearDraft(client?.localDataScope, draftScope);
      setDraft("");
      clearAttachments();
      if (client) {
        setTimeout(() => void load(), 500);
      }
    } catch (err) {
      if (!isUncertainOutcomeError(err)) {
        pendingSendRef.current = null;
        setRetryModeLocked(false);
      } else {
        setRetryModeLocked(true);
        saveDraft(client?.localDataScope, draftScope, draft, {
          key: idempotencyKey,
          queue,
        });
      }
      haptics.warning();
      setError(err instanceof Error ? err.message : "Could not send reply.");
    } finally {
      setSending(false);
    }
  }

  async function handleSchedule(sendAt: number) {
    if (!onScheduleReply || scheduleBusy || sending) return;
    const trimmed = draft.trim();
    const { readyIds, readyNames, uploading, hasErrors, clearAttachments } =
      replyAttachments;
    if (
      !pendingSchedule &&
      ((!trimmed && readyIds.length === 0) || uploading || hasErrors)
    )
      return;
    const finalText =
      pendingSchedule?.input ??
      (trimmed ||
        (readyNames.length === 1
          ? `Attached ${readyNames[0]}`
          : `Attached ${readyNames.length} files`));
    const nextPending = pendingSchedule ?? {
      idempotencyKey: randomUuid(),
      sendAt,
      input: finalText,
      agentId: resolvedAgentId || undefined,
      attachmentIds: readyIds,
      locked: false,
    };
    setScheduleBusy(true);
    setScheduleError("");
    try {
      await saveDraftAndFlush(
        client?.localDataScope,
        draftScope,
        trimmed || finalText,
        {
          schedule: {
            key: nextPending.idempotencyKey,
            sendAt: nextPending.sendAt,
            input: nextPending.input,
            ...(nextPending.agentId ? { agentId: nextPending.agentId } : {}),
            attachmentIds: nextPending.attachmentIds,
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
    setPendingSchedule(nextPending);
    try {
      await onScheduleReply({
        conversationId,
        agentId: nextPending.agentId || resolvedAgentId || "",
        agentName,
        text: nextPending.input,
        attachmentIds: nextPending.attachmentIds,
        idempotencyKey: nextPending.idempotencyKey,
        sendAt: nextPending.sendAt,
      });
      setPendingSchedule(null);
      setScheduleOpen(false);
      pendingSendRef.current = null;
      setRetryModeLocked(false);
      clearDraft(client?.localDataScope, draftScope);
      setDraft("");
      clearAttachments();
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
        if (draft.trim()) saveDraft(client?.localDataScope, draftScope, draft);
        else clearDraft(client?.localDataScope, draftScope);
      }
      haptics.warning();
      setScheduleError(
        err instanceof Error ? err.message : "Could not schedule message.",
      );
    } finally {
      setScheduleBusy(false);
    }
  }

  function handleCopyMessage(msg: ApiMessage) {
    void copyTrackerRef.current.copy(
      () => Clipboard.setStringAsync(msg.content),
      {
        onSuccess: () => {
          haptics.success();
          setCopiedMsgId(msg.id);
        },
        onReset: () => setCopiedMsgId(null),
        onError: () => haptics.warning(),
      },
    );
  }

  async function handleToggleSave(msgId: string) {
    if (pendingBookmarks.current.has(msgId)) return;
    const isSaved = savedIds.has(msgId);
    pendingBookmarks.current.add(msgId);
    bookmarkRevision.current++;
    haptics.medium();
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (isSaved) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
    try {
      await onToggleSaved(msgId, isSaved);
    } catch {
      // revert on failure
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (isSaved) next.add(msgId);
        else next.delete(msgId);
        return next;
      });
    } finally {
      pendingBookmarks.current.delete(msgId);
      bookmarkRevision.current++;
    }
  }

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.bg, zIndex: 45 },
      ]}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Top Bar */}
        <View
          style={[
            styles.header,
            {
              paddingTop: Math.max(insets.top + 8, 18),
              borderBottomColor: theme.line,
              backgroundColor: theme.surface,
            },
          ]}
        >
          <Pressable
            onPress={() => {
              haptics.light();
              onClose();
            }}
            style={[
              styles.backBtn,
              { backgroundColor: theme.soft, borderColor: theme.line },
            ]}
          >
            <ArrowLeft size={18} color={theme.text} />
          </Pressable>

          <View style={styles.headerCenter}>
            <View style={styles.headerAgentRow}>
              <AgentAvatar name={agentName} size={20} />
              <Text style={[styles.headerAgent, { color: theme.text }]}>
                @{agentName}
              </Text>
              {(working || activeRun) && (
                <View
                  style={[
                    styles.workingBadge,
                    {
                      backgroundColor:
                        activeRun?.state === "failed" ||
                        activeRun?.state === "interrupted"
                          ? theme.orangeSoft
                          : theme.blueSoft,
                    },
                  ]}
                >
                  <Sparkles
                    size={10}
                    color={
                      activeRun?.state === "failed" ||
                      activeRun?.state === "interrupted"
                        ? theme.orange
                        : theme.blue
                    }
                  />
                  <Text
                    style={[
                      styles.workingText,
                      {
                        color:
                          activeRun?.state === "failed" ||
                          activeRun?.state === "interrupted"
                            ? theme.orange
                            : theme.blue,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {liveStream?.activity ||
                      (activeRun?.state === "paused"
                        ? "Paused"
                        : activeRun?.state === "failed"
                          ? "Failed"
                          : activeRun?.state === "interrupted"
                            ? "Interrupted"
                            : "Working")}
                  </Text>
                </View>
              )}
            </View>
            <Text
              style={[styles.headerTitle, { color: theme.muted }]}
              numberOfLines={1}
            >
              {resolvedTitle}
            </Text>
          </View>
        </View>

        {/* Active Run Control Strip (Pause / Resume / Stop / Retry) */}
        {activeRun && onControlRun && (
          <View
            style={[
              styles.runBar,
              {
                backgroundColor: theme.surface,
                borderBottomColor: theme.line,
              },
            ]}
          >
            <Text
              style={[styles.runBarLabel, { color: theme.muted }]}
              numberOfLines={1}
            >
              {liveStream?.activity ||
                (activeRun.state === "paused"
                  ? "Run paused"
                  : activeRun.state === "failed"
                    ? "Run failed — retry?"
                    : activeRun.state === "interrupted"
                      ? "Run interrupted — retry?"
                      : "Active run")}
            </Text>
            <View style={styles.runBarActions}>
              {canPause &&
                (activeRun.state === "running" ||
                  activeRun.state === "waiting_children") && (
                  <Pressable
                    onPress={() => {
                      haptics.light();
                      onControlRun(activeRun.id, "pause");
                    }}
                    style={[
                      styles.runBtn,
                      { backgroundColor: theme.soft, borderColor: theme.line },
                    ]}
                  >
                    <Pause size={12} color={theme.text} />
                    <Text style={[styles.runBtnText, { color: theme.text }]}>
                      Pause
                    </Text>
                  </Pressable>
                )}
              {activeRun.state === "paused" && (
                <Pressable
                  onPress={() => {
                    haptics.light();
                    onControlRun(activeRun.id, "resume");
                  }}
                  style={[
                    styles.runBtn,
                    {
                      backgroundColor: theme.attention,
                      borderColor: theme.attentionLine,
                    },
                  ]}
                >
                  <Play size={12} color={theme.brassText} />
                  <Text style={[styles.runBtnText, { color: theme.brassText }]}>
                    Resume
                  </Text>
                </Pressable>
              )}
              {(activeRun.state === "failed" ||
                activeRun.state === "interrupted") && (
                <Pressable
                  onPress={() => {
                    haptics.medium();
                    onControlRun(activeRun.id, "retry");
                  }}
                  style={[
                    styles.runBtn,
                    {
                      backgroundColor: theme.attention,
                      borderColor: theme.attentionLine,
                    },
                  ]}
                >
                  <RotateCcw size={12} color={theme.brassText} />
                  <Text style={[styles.runBtnText, { color: theme.brassText }]}>
                    Retry
                  </Text>
                </Pressable>
              )}
              {(activeRun.state === "running" ||
                activeRun.state === "pausing" ||
                activeRun.state === "paused" ||
                activeRun.state === "waiting_children") && (
                <Pressable
                  onPress={() => {
                    haptics.warning();
                    onControlRun(activeRun.id, "cancel");
                  }}
                  style={[
                    styles.runBtn,
                    {
                      backgroundColor: theme.orangeSoft,
                      borderColor: theme.orange,
                    },
                  ]}
                >
                  <Square size={11} color={theme.orange} />
                  <Text style={[styles.runBtnText, { color: theme.orange }]}>
                    Stop
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {/* Chronological Message Stream */}
        {/* Keep first-tap actions (Select text, Copy, Save, links) responsive while the
            reply keyboard is open, while allowing swipe-down interactive dismissal. */}
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.messagesContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => {
            if (Date.now() < suppressAutoScrollUntilRef.current) {
              return;
            }
            scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={theme.brassText} />
            </View>
          ) : error ? (
            <Text style={[styles.errorText, { color: theme.orange }]}>
              {error}
            </Text>
          ) : (
            <>
              {nextCursor && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load earlier messages"
                  disabled={loadingMore}
                  onPress={() => {
                    haptics.light();
                    void loadEarlier();
                  }}
                  style={({ pressed }) => [
                    styles.loadEarlierBtn,
                    {
                      backgroundColor: pressed ? theme.attention : theme.soft,
                      borderColor: theme.line,
                      opacity: loadingMore ? 0.65 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.loadEarlierText, { color: theme.text }]}>
                    {loadingMore
                      ? "Loading earlier messages…"
                      : "Load earlier messages"}
                  </Text>
                </Pressable>
              )}
              {messages.map((msg) => {
                const isUser = msg.role === "user";
                const isSaved = savedIds.has(msg.id);
                const isCopied = copiedMsgId === msg.id;
                return (
                  <View
                    key={msg.id}
                    style={[
                      styles.msgCard,
                      isUser
                        ? {
                            backgroundColor: theme.attention,
                            borderColor: theme.attentionLine,
                            alignSelf: "flex-end",
                            maxWidth: "88%",
                          }
                        : {
                            backgroundColor: theme.surface,
                            borderColor: theme.line,
                          },
                    ]}
                  >
                    <View style={styles.msgHead}>
                      <Text
                        style={[
                          styles.msgAuthor,
                          { color: isUser ? theme.brassText : theme.muted },
                        ]}
                      >
                        {isUser ? "You" : `@${agentName}`} ·{" "}
                        {relativeTime(msg.created_at)}
                      </Text>
                      <View style={styles.msgHeadActions}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Select text"
                          onPress={() =>
                            openSelectModal(
                              isUser ? "You" : `@${agentName}`,
                              msg.content,
                            )
                          }
                          hitSlop={8}
                        >
                          <TextSelect size={14} color={theme.muted} />
                        </Pressable>
                        <Pressable
                          accessibilityLabel={
                            isCopied ? "Message copied" : "Copy message"
                          }
                          onPress={() => handleCopyMessage(msg)}
                          hitSlop={8}
                        >
                          {isCopied ? (
                            <Check size={14} color={theme.brassText} />
                          ) : (
                            <Copy size={14} color={theme.muted} />
                          )}
                        </Pressable>
                        {!isUser && (
                          <Pressable
                            accessibilityLabel={
                              isSaved ? "Remove from Saved" : "Save message"
                            }
                            onPress={() => void handleToggleSave(msg.id)}
                            hitSlop={8}
                          >
                            {isSaved ? (
                              <BookmarkCheck
                                size={15}
                                color={theme.brassText}
                              />
                            ) : (
                              <Bookmark size={15} color={theme.muted} />
                            )}
                          </Pressable>
                        )}
                      </View>
                    </View>
                    {isUser ? (
                      <Text
                        selectable
                        style={[styles.userText, { color: theme.text }]}
                      >
                        {msg.content}
                      </Text>
                    ) : (
                      <>
                        <RichContent
                          content={msg.content}
                          theme={theme}
                          selectable
                          workspaceOrigin={client?.origin}
                          onOpenFile={onOpenFileTarget}
                          onReplyButton={(prompt) => {
                            if (scheduleLocked) return;
                            draftTouchedRef.current = true;
                            pendingSendRef.current = null;
                            setDraft(prompt);
                            saveDraft(
                              client?.localDataScope,
                              draftScope,
                              prompt,
                            );
                          }}
                        />
                        {msg.run_id &&
                        (runFilesByRunId.get(msg.run_id)?.length ?? 0) > 0 ? (
                          <PublishedFilesStrip
                            files={runFilesByRunId.get(msg.run_id)!}
                            client={client}
                            theme={theme}
                            onOpenFile={onOpenFile}
                          />
                        ) : null}
                      </>
                    )}
                  </View>
                );
              })}

              {(working ||
                (activeRun &&
                  [
                    "running",
                    "pausing",
                    "awaiting_approval",
                    "waiting_children",
                  ].includes(activeRun.state))) &&
                liveStream &&
                !liveStream.gapped &&
                (liveStream.text.trim().length > 0 || liveStream.activity) &&
                !messages.some((m, idx) => {
                  if (m.role !== "assistant") return false;
                  const trimmedStream = liveStream.text.trim();
                  if (liveStream.messageId) {
                    if (
                      m.id === liveStream.messageId &&
                      m.content.trim().length >= trimmedStream.length
                    ) {
                      return true;
                    }
                    // Only compare text against the latest persisted message of this run so
                    // an identical earlier reply (e.g. "Done") never hides a new live turn.
                    return (
                      idx === messages.length - 1 &&
                      Boolean(activeRun && m.run_id === activeRun.id) &&
                      trimmedStream.length > 0 &&
                      m.content.trim() === trimmedStream
                    );
                  }
                  return (
                    activeRun !== null &&
                    m.run_id === activeRun.id &&
                    trimmedStream.length > 0 &&
                    m.content.trim().length >= trimmedStream.length
                  );
                }) && (
                  <View
                    style={[
                      styles.msgCard,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.blue,
                      },
                    ]}
                  >
                    <View style={styles.msgHead}>
                      <Text style={[styles.msgAuthor, { color: theme.blue }]}>
                        @{agentName} · {liveStream.activity || "Streaming…"}
                      </Text>
                      <View style={styles.msgHeadActions}>
                        {liveStream.text.trim().length > 0 ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Select text"
                            onPress={() =>
                              openSelectModal(
                                `@${agentName}`,
                                liveStream.text,
                                true,
                              )
                            }
                            hitSlop={8}
                          >
                            <TextSelect size={14} color={theme.muted} />
                          </Pressable>
                        ) : null}
                        <ActivityIndicator size="small" color={theme.blue} />
                      </View>
                    </View>
                    {liveStream.text.trim().length > 0 ? (
                      <RichContent
                        content={liveStream.text}
                        theme={theme}
                        selectable={false}
                        workspaceOrigin={client?.origin}
                        onOpenFile={onOpenFileTarget}
                      />
                    ) : null}
                  </View>
                )}
            </>
          )}
        </ScrollView>

        {/* Bottom Reply Composer */}
        <View
          style={[
            styles.composerDock,
            {
              borderTopColor: theme.line,
              backgroundColor: theme.surface,
              paddingBottom: Math.max(insets.bottom + 8, 12),
            },
          ]}
        >
          {canSteerActiveRun && (
            <View style={styles.deliveryRow}>
              <Pressable
                disabled={sending || retryModeLocked}
                onPress={() => {
                  haptics.selection();
                  setDeliveryMode("steer");
                }}
                style={[
                  styles.deliveryPill,
                  {
                    backgroundColor:
                      deliveryMode === "steer" ? theme.attention : theme.soft,
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
                    styles.deliveryPillText,
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
                  styles.deliveryPill,
                  {
                    backgroundColor:
                      deliveryMode === "queue" ? theme.attention : theme.soft,
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
                    styles.deliveryPillText,
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
          {draftLoadError && (
            <Text style={{ color: theme.orange }}>
              Could not load the saved draft. Close and reopen to retry.
            </Text>
          )}
          <AttachmentChipStrip
            attachments={replyAttachments.attachments}
            theme={theme}
            locked={scheduleLocked}
            onRemove={replyAttachments.removeAttachment}
            onRetry={(id) => void replyAttachments.retryAttachment(id)}
          />
          <View
            style={[
              styles.composerPill,
              { backgroundColor: theme.soft, borderColor: theme.line },
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
                styles.attachBtn,
                (!replyAttachments.canAddMore ||
                  sending ||
                  scheduleBusy ||
                  scheduleLocked) && {
                  opacity: 0.4,
                },
              ]}
            >
              <Paperclip
                size={17}
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
                setError("");
                void replyAttachments.addFiles([file]);
              }}
              onError={(msg) => setError(msg)}
            />
            <TextInput
              value={draft}
              editable={
                draftLoaded && !sending && !scheduleBusy && !scheduleLocked
              }
              onChangeText={(next) => {
                draftTouchedRef.current = true;
                pendingSendRef.current = null;
                setDraft(next);
                saveDraft(client?.localDataScope, draftScope, next);
              }}
              placeholder={`Reply to @${agentName}…`}
              placeholderTextColor={theme.muted}
              style={[styles.composerInput, { color: theme.text }]}
              multiline
            />
            {client && onScheduleReply && (
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
                  styles.attachBtn,
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
            <Pressable
              disabled={
                !draftLoaded ||
                (!draft.trim() && replyAttachments.readyIds.length === 0) ||
                replyAttachments.uploading ||
                replyAttachments.hasErrors ||
                recordingAudio ||
                sending ||
                scheduleBusy ||
                Boolean(pendingSchedule)
              }
              onPress={() => void handleSend()}
              style={[
                styles.sendBtn,
                {
                  backgroundColor: theme.brass,
                  opacity:
                    !draftLoaded ||
                    (!draft.trim() && replyAttachments.readyIds.length === 0) ||
                    replyAttachments.uploading ||
                    replyAttachments.hasErrors ||
                    recordingAudio ||
                    sending ||
                    scheduleBusy ||
                    Boolean(pendingSchedule)
                      ? 0.36
                      : 1,
                },
              ]}
            >
              <ArrowUp size={17} color={theme.onBrass} strokeWidth={2.4} />
            </Pressable>
          </View>
        </View>
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
        onConfirm={(sendAt) => void handleSchedule(sendAt)}
        onDiscardPending={() => {
          setPendingSchedule(null);
          setScheduleError("");
          setScheduleOpen(false);
          if (draft.trim())
            saveDraft(client?.localDataScope, draftScope, draft);
          else clearDraft(client?.localDataScope, draftScope);
        }}
      />

      <Modal
        visible={Boolean(selectingMessage)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeSelectModal}
      >
        <View
          style={[
            styles.selectModalRoot,
            {
              backgroundColor: theme.bg,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <View
            style={[
              styles.selectModalHeader,
              {
                backgroundColor: theme.surface,
                borderBottomColor: theme.line,
              },
            ]}
          >
            <View style={styles.selectModalTitleWrap}>
              <Text style={[styles.selectModalTitle, { color: theme.text }]}>
                Select text
              </Text>
              {selectingMessage ? (
                <Text
                  style={[styles.selectModalSub, { color: theme.muted }]}
                  numberOfLines={1}
                >
                  {selectingMessage.author}
                  {selectingMessage.streamingSnapshot
                    ? " · snapshot while streaming"
                    : ""}{" "}
                  · drag handles to select any portion
                </Text>
              ) : null}
            </View>
            <View style={styles.selectModalActions}>
              {selectingMessage ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    selectModalCopied ? "Copied all text" : "Copy all text"
                  }
                  onPress={() => {
                    void selectCopyTrackerRef.current.copy(
                      () => Clipboard.setStringAsync(selectingMessage.content),
                      {
                        onSuccess: () => {
                          haptics.success();
                          setSelectModalCopied(true);
                        },
                        onReset: () => setSelectModalCopied(false),
                        onError: () => haptics.warning(),
                      },
                    );
                  }}
                  style={[
                    styles.selectModalBtn,
                    {
                      backgroundColor: theme.raised,
                      borderColor: theme.line,
                    },
                  ]}
                >
                  {selectModalCopied ? (
                    <Check size={14} color={theme.brassText} />
                  ) : (
                    <Copy size={14} color={theme.muted} />
                  )}
                  <Text
                    style={[
                      styles.selectModalBtnText,
                      {
                        color: selectModalCopied ? theme.brassText : theme.text,
                      },
                    ]}
                  >
                    {selectModalCopied ? "Copied" : "Copy all"}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close text selection"
                onPress={closeSelectModal}
                style={[
                  styles.selectModalCloseBtn,
                  {
                    backgroundColor: theme.raised,
                    borderColor: theme.line,
                  },
                ]}
              >
                <X size={16} color={theme.text} />
              </Pressable>
            </View>
          </View>
          {selectingMessage ? (
            Platform.OS === "ios" ? (
              <TextInput
                value={selectingMessage.content}
                editable={false}
                multiline
                scrollEnabled
                textAlignVertical="top"
                style={[styles.selectModalInput, { color: theme.text }]}
              />
            ) : (
              <ScrollView
                style={styles.flex}
                contentContainerStyle={styles.selectModalScroll}
              >
                <Text
                  selectable
                  style={[styles.selectModalText, { color: theme.text }]}
                >
                  {selectingMessage.content}
                </Text>
              </ScrollView>
            )
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    gap: 2,
  },
  headerAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  headerAgent: {
    fontSize: 15,
    fontWeight: "700",
  },
  workingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  workingText: {
    fontSize: 11,
    fontWeight: "700",
  },
  headerTitle: {
    fontSize: 12.5,
  },
  messagesContent: {
    padding: 14,
    gap: 12,
  },
  centered: {
    paddingVertical: 48,
    alignItems: "center",
  },
  msgCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  msgHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  msgHeadActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  loadEarlierBtn: {
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 4,
  },
  loadEarlierText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  msgAuthor: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  userText: {
    fontSize: 15,
    lineHeight: 22,
  },
  errorText: {
    fontSize: 13.5,
    textAlign: "center",
    padding: 20,
  },
  composerDock: {
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  runBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  runBarLabel: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "600",
  },
  runBarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  runBtnText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  deliveryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  deliveryPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  deliveryPillText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  composerPill: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderRadius: 24,
    borderWidth: 1,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 6,
  },
  attachBtn: {
    width: 32,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  composerInput: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    maxHeight: 96,
    paddingVertical: 5,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  selectModalRoot: {
    flex: 1,
  },
  selectModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  selectModalTitleWrap: {
    flex: 1,
    gap: 2,
  },
  selectModalTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  selectModalSub: {
    fontSize: 12,
  },
  selectModalActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  selectModalBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  selectModalBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
  selectModalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  selectModalInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15.5,
    lineHeight: 23,
  },
  selectModalScroll: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  selectModalText: {
    fontSize: 15.5,
    lineHeight: 23,
  },
});
