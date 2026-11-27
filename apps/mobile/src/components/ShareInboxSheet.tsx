import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
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
import * as Sharing from "expo-sharing";
import {
  FileText,
  Folder,
  Globe,
  Link2,
  Send,
  Share2,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isUncertainOutcomeError,
  LoopApiError,
  randomUuid,
  type LoopClient,
} from "../api/client";
import type { ApiAgent, ApiFolder } from "../api/types";
import {
  clearDraft,
  draftScopeForShare,
  loadDraftEntry,
  saveDraftAndFlush,
  type PendingShareDraft,
} from "../drafts";
import { haptics } from "../haptics";
import { fileBytes } from "../file-bytes";
import {
  buildShareSendPayload,
  classifyShareSendFailure,
  extractLeadingShareHandle,
  normalizeIncomingSharePayloads,
  type NormalizedIncomingShare,
  type RawIncomingSharePayload,
} from "../share-utils";
import type { LoopTheme } from "../theme";

function readNativeSharedPayloads(): RawIncomingSharePayload[] {
  try {
    if (typeof Sharing.getSharedPayloads !== "function") return [];
    const list = Sharing.getSharedPayloads();
    return Array.isArray(list) ? (list as RawIncomingSharePayload[]) : [];
  } catch {
    return [];
  }
}

function clearNativeSharedPayloads(): void {
  try {
    if (typeof Sharing.clearSharedPayloads === "function") {
      Sharing.clearSharedPayloads();
    }
  } catch {
    // Graceful no-op when native share receiver is unavailable.
  }
}

/**
 * Safely observes incoming OS share-sheet payloads without crashing on builds
 * where `expo-sharing`'s experimental share receiver is unavailable.
 * Only calls `getResolvedSharedPayloadsAsync` when binary files are shared so
 * shared web URLs are never silently fetched by the device.
 */
export function useIncomingShareIntake(): {
  incomingShare: NormalizedIncomingShare | null;
  dismissIncomingShare: () => void;
} {
  const [incomingShare, setIncomingShare] =
    useState<NormalizedIncomingShare | null>(null);
  const activeKeyRef = useRef<string>("");
  const pollGenRef = useRef(0);

  const poll = useCallback(async () => {
    const raw = readNativeSharedPayloads();
    if (raw.length === 0) {
      activeKeyRef.current = "";
      return;
    }
    const rawKey = raw
      .map((r) => `${r.shareType}|${r.mimeType ?? ""}|${r.value}`)
      .join("::");
    // Check identical payload BEFORE bumping pollGenRef so a duplicate foreground
    // AppState event does not cancel an in-flight binary file resolution.
    if (rawKey === activeKeyRef.current) return;
    activeKeyRef.current = rawKey;
    const gen = ++pollGenRef.current;

    let effective: RawIncomingSharePayload[] = raw;
    const hasBinaryFile = raw.some(
      (r) =>
        r.shareType === "file" ||
        r.shareType === "image" ||
        r.shareType === "audio" ||
        r.shareType === "video",
    );
    if (
      hasBinaryFile &&
      typeof Sharing.getResolvedSharedPayloadsAsync === "function"
    ) {
      try {
        const resolved = await Sharing.getResolvedSharedPayloadsAsync();
        if (gen !== pollGenRef.current) return;
        if (Array.isArray(resolved) && resolved.length > 0) {
          effective = resolved as RawIncomingSharePayload[];
        }
      } catch {
        if (gen !== pollGenRef.current) return;
        // Fall back to raw payloads if resolution fails.
      }
    }

    if (gen !== pollGenRef.current) return;
    const normalized = normalizeIncomingSharePayloads(effective);
    if (normalized) {
      setIncomingShare(normalized);
    }
  }, []);

  useEffect(() => {
    void poll();
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "background") {
        // Allow re-sharing the same link/file when returning from another app
        activeKeyRef.current = "";
      } else if (nextState === "active") {
        void poll();
      }
    });
    return () => sub.remove();
  }, [poll]);

  const dismissIncomingShare = useCallback(() => {
    pollGenRef.current += 1;
    setIncomingShare(null);
    clearNativeSharedPayloads();
  }, []);

  return { incomingShare, dismissIncomingShare };
}

export function ShareInboxSheet({
  share,
  client,
  agents,
  folders,
  theme,
  onClose,
  onOpenPairing,
  onSent,
}: {
  share: NormalizedIncomingShare;
  client: LoopClient | null;
  agents: ApiAgent[];
  folders: ApiFolder[];
  theme: LoopTheme;
  onClose: () => void;
  onOpenPairing: () => void;
  onSent: (
    message: string,
    conversationId?: string,
    agentName?: string,
  ) => void;
}) {
  const insets = useSafeAreaInsets();
  const activeAgents = useMemo(
    () => agents.filter((a) => !a.retired_at),
    [agents],
  );
  const [question, setQuestion] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    () => activeAgents[0]?.id ?? "",
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingLoaded, setPendingLoaded] = useState(!client);
  const [uncertainRetryLocked, setUncertainRetryLocked] = useState(false);
  const [error, setError] = useState("");
  const [routedNotice, setRoutedNotice] = useState("");

  // Durable idempotency key + full send metadata persisted before dispatch;
  // restored after dismiss or restart so retries reuse identical agent, folder,
  // attachmentIds, question, and request key.
  const idempotencyKeyRef = useRef<string>(randomUuid());
  const lockedPendingShareRef = useRef<PendingShareDraft | null>(null);
  const uploadedIdsByKeyRef = useRef<Map<string, string>>(new Map());
  const clientRef = useRef<LoopClient | null>(client);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset state on workspace switch and restore any durable pending share from disk
  useEffect(() => {
    clientRef.current = client;
    idempotencyKeyRef.current = randomUuid();
    lockedPendingShareRef.current = null;
    uploadedIdsByKeyRef.current = new Map();
    setSending(false);
    setUncertainRetryLocked(false);
    setError("");
    setRoutedNotice("");
    if (!client) {
      setPendingLoaded(true);
      return;
    }
    setPendingLoaded(false);
    let cancelled = false;
    const scope = draftScopeForShare(share.fingerprint);
    void loadDraftEntry(client.origin, scope)
      .then((entry) => {
        if (cancelled || !mountedRef.current || clientRef.current !== client) {
          return;
        }
        const pending = entry?.pendingShare;
        if (entry && pending?.key) {
          idempotencyKeyRef.current = pending.key;
          lockedPendingShareRef.current = pending;
          setQuestion(entry.text);
          if (pending.agentId) setSelectedAgentId(pending.agentId);
          if (pending.folderId !== undefined) {
            setSelectedFolderId(pending.folderId);
          }
          setUncertainRetryLocked(true);
          setError(
            "A previous send of this shared item timed out — tap Retry safely to reuse the exact request ID, or Cancel to check your Feed.",
          );
        }
        setPendingLoaded(true);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current && clientRef.current === client) {
          setPendingLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, share.fingerprint]);

  // Keep selectedAgentId valid when agent list loads (without overriding a locked pending retry)
  useEffect(() => {
    if (lockedPendingShareRef.current?.agentId) return;
    if (
      activeAgents.length > 0 &&
      !activeAgents.some((a) => a.id === selectedAgentId)
    ) {
      setSelectedAgentId(activeAgents[0].id);
    }
  }, [activeAgents, selectedAgentId]);

  // If the user types a leading @handle, ask /api/share/preview who it routes to
  useEffect(() => {
    if (!client) return;
    const trimmed = question.trim();
    if (!trimmed.startsWith("@")) {
      setRoutedNotice("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .sharePreview({
          question: trimmed,
          ...(share.sourceUrl
            ? {
                source: {
                  url: share.sourceUrl,
                  title: share.sourceTitle ?? "",
                  excerpt: share.sharedText ?? "",
                },
              }
            : share.sharedText
              ? { sharedText: share.sharedText }
              : {}),
          ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        })
        .then((res) => {
          if (cancelled) return;
          if (res.agent) {
            setSelectedAgentId(res.agent.id);
            setRoutedNotice(`Routing to @${res.agent.name}`);
          } else {
            setRoutedNotice("");
          }
        })
        .catch(() => {
          if (!cancelled) setRoutedNotice("");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    client,
    question,
    selectedFolderId,
    share.sharedText,
    share.sourceTitle,
    share.sourceUrl,
  ]);

  const handleResetPendingLock = useCallback(() => {
    if (!client || sending) return;
    clearDraft(client.origin, draftScopeForShare(share.fingerprint));
    lockedPendingShareRef.current = null;
    idempotencyKeyRef.current = randomUuid();
    setUncertainRetryLocked(false);
    setError("");
  }, [client, sending, share.fingerprint]);

  const handleSend = useCallback(async () => {
    if (!client || sending || !pendingLoaded) return;
    const activeClient = client;
    const locked = lockedPendingShareRef.current;
    const wasAlreadyUncertainRetry = Boolean(locked);
    const trimmed = question.trim() || "Summarize and analyze this.";
    const leadingHandle = extractLeadingShareHandle(trimmed);
    const routedAgent = leadingHandle
      ? activeAgents.find(
          (a) => a.name.toLowerCase() === leadingHandle.toLowerCase(),
        )
      : undefined;
    const targetAgentId = locked
      ? (locked.agentId ?? "")
      : leadingHandle
        ? (routedAgent?.id ?? "")
        : selectedAgentId;
    const targetFolderId =
      locked && locked.folderId !== undefined
        ? locked.folderId
        : selectedFolderId;
    const agent = activeAgents.find((a) => a.id === targetAgentId);
    if (!agent && !targetAgentId && !leadingHandle) {
      setError("Choose an agent first.");
      return;
    }

    setSending(true);
    setError("");
    haptics.medium();

    const shareScope = draftScopeForShare(share.fingerprint);
    let sendDispatched = wasAlreadyUncertainRetry;
    try {
      const effectiveFolderId = targetFolderId ?? agent?.folder_id ?? undefined;
      let attachmentIds: string[] = [];
      if (locked?.attachmentIds && locked.attachmentIds.length > 0) {
        // Reuse the exact persisted artifact IDs from the uncertain original send
        attachmentIds = locked.attachmentIds;
      } else if (share.files.length > 0) {
        const destPrefix = `${targetAgentId || leadingHandle || ""}|${effectiveFolderId ?? ""}|`;
        for (const f of share.files) {
          const cacheKey = `${destPrefix}${f.uri}`;
          const existingId = uploadedIdsByKeyRef.current.get(cacheKey);
          if (existingId) {
            attachmentIds.push(existingId);
            continue;
          }
          try {
            const uploaded = await activeClient.uploadFile(
              {
                uri: f.uri,
                name: f.name,
                mimeType: f.mimeType,
                bytes: fileBytes(f.uri),
              },
              {
                agentId: targetAgentId || undefined,
                folderId: effectiveFolderId ?? null,
              },
            );
            if (!mountedRef.current || clientRef.current !== activeClient) {
              return;
            }
            uploadedIdsByKeyRef.current.set(cacheKey, uploaded.id);
            attachmentIds.push(uploaded.id);
          } catch (uploadErr) {
            if (!mountedRef.current || clientRef.current !== activeClient) {
              return;
            }
            // Upload errors happen BEFORE POST /api/share/send — never falsely claim
            // an idempotent request lock or replay an uncertain shareSend.
            setError(
              isUncertainOutcomeError(uploadErr)
                ? `Uploading "${f.name}" timed out — check Profile → Files to see if it finished, or tap Send to try uploading again.`
                : uploadErr instanceof Error
                  ? uploadErr.message
                  : `Could not upload "${f.name}".`,
            );
            return;
          }
        }
      }

      const pendingMeta: PendingShareDraft = {
        key: idempotencyKeyRef.current,
        agentId: targetAgentId || null,
        folderId: targetFolderId ?? null,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      };

      // Persist durable idempotency key + full send metadata BEFORE POST /api/share/send.
      // Handle local persistence failures separately so they NEVER clear an existing lock.
      try {
        await saveDraftAndFlush(activeClient.origin, shareScope, trimmed, {
          share: pendingMeta,
        });
      } catch (persistErr) {
        if (mountedRef.current && clientRef.current === activeClient) {
          setError(
            persistErr instanceof Error
              ? persistErr.message
              : "Could not save local recovery state. Please try again.",
          );
        }
        return;
      }
      if (!mountedRef.current || clientRef.current !== activeClient) return;
      lockedPendingShareRef.current = pendingMeta;

      // All shares (links, text, and files) route through POST /api/share/send
      // so the server consistently applies untrusted-share handling (`shared: true`).
      const payload = buildShareSendPayload({
        question: trimmed,
        share,
        folderId: targetFolderId,
        agentId: targetAgentId || undefined,
        attachmentIds,
        idempotencyKey: idempotencyKeyRef.current,
      });
      if (!payload) {
        if (!wasAlreadyUncertainRetry) {
          clearDraft(activeClient.origin, shareScope);
          lockedPendingShareRef.current = null;
        }
        setError("Could not prepare shared request.");
        return;
      }
      sendDispatched = true;
      const runResult = await activeClient.shareSend(payload);

      // Always clear persisted pendingShare on confirmed success even if the sheet
      // unmounted or switched workspaces mid-flight, so re-sharing later never stalls.
      clearDraft(activeClient.origin, shareScope);
      if (!mountedRef.current || clientRef.current !== activeClient) return;
      lockedPendingShareRef.current = null;
      setUncertainRetryLocked(false);
      haptics.success();
      const targetName =
        routedAgent?.name ?? leadingHandle ?? agent?.name ?? "agent";
      onSent(`Sent to @${targetName}`, runResult.conversation_id, targetName);
    } catch (err) {
      if (!sendDispatched) {
        if (mountedRef.current && clientRef.current === activeClient) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not send shared content.",
          );
        }
        return;
      }
      const outcome = classifyShareSendFailure({
        wasRetry: wasAlreadyUncertainRetry,
        isUncertain: isUncertainOutcomeError(err),
        status: err instanceof LoopApiError ? err.status : undefined,
        message: err instanceof Error ? err.message : undefined,
      });
      if (outcome !== "clear-and-rotate") {
        if (!mountedRef.current || clientRef.current !== activeClient) return;
        // Preserve persisted pendingShare and NEVER rotate key automatically on
        // uncertain outcomes, idempotency conflicts, or retries of uncertain sends.
        setUncertainRetryLocked(true);
        const serverMsg =
          err instanceof Error && err.message ? `${err.message} ` : "";
        setError(
          outcome === "keep-lock-conflict"
            ? "This request key is already recorded on the server — check your Feed, or tap Start fresh to send a new request."
            : outcome === "keep-lock-retry-rejected"
              ? `${serverMsg}Check your Feed to verify whether the earlier send completed, or tap Start fresh.`
              : "Send timed out — tap Retry safely to reuse the exact request ID, or Cancel to check your Feed.",
        );
      } else {
        // Definite first-attempt rejection (no prior uncertain send existed):
        // clear persisted lock even if unmounted, and rotate key for a revised send.
        clearDraft(activeClient.origin, shareScope);
        if (!mountedRef.current || clientRef.current !== activeClient) return;
        lockedPendingShareRef.current = null;
        setUncertainRetryLocked(false);
        idempotencyKeyRef.current = randomUuid();
        setError(
          err instanceof Error ? err.message : "Could not send shared content.",
        );
      }
    } finally {
      if (mountedRef.current && clientRef.current === activeClient) {
        setSending(false);
      }
    }
  }, [
    activeAgents,
    client,
    onSent,
    pendingLoaded,
    question,
    selectedAgentId,
    selectedFolderId,
    sending,
    share,
  ]);

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!sending) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.backdrop}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.bg,
              borderColor: theme.line,
              paddingBottom: Math.max(insets.bottom + 14, 20),
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.line }]}>
            <View style={styles.headerLeft}>
              <Share2 size={16} color={theme.brassText} />
              <Text style={[styles.title, { color: theme.text }]}>
                Bring into Loop
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss shared content"
              disabled={sending}
              onPress={onClose}
              hitSlop={10}
              style={[
                styles.closeBtn,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.line,
                  opacity: sending ? 0.45 : 1,
                },
              ]}
            >
              <X size={16} color={theme.muted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Shared content preview */}
            {share.sourceUrl ? (
              <View
                style={[
                  styles.previewCard,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.previewRow}>
                  <Globe size={14} color={theme.brassText} />
                  <Text
                    style={[styles.previewHost, { color: theme.brassText }]}
                    numberOfLines={1}
                  >
                    {share.sourceTitle || "Shared link"}
                  </Text>
                </View>
                <Text
                  style={[styles.previewUrl, { color: theme.muted }]}
                  numberOfLines={2}
                >
                  {share.sourceUrl}
                </Text>
              </View>
            ) : null}

            {share.sharedText ? (
              <View
                style={[
                  styles.previewCard,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <Text
                  style={[styles.previewText, { color: theme.text }]}
                  numberOfLines={4}
                >
                  {share.sharedText}
                </Text>
              </View>
            ) : null}

            {share.files.length > 0 ? (
              <View style={styles.fileChipRow}>
                {share.files.map((f, idx) => (
                  <View
                    key={`${f.uri}-${idx}`}
                    style={[
                      styles.fileChip,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <FileText size={13} color={theme.brassText} />
                    <Text
                      style={[styles.fileChipText, { color: theme.text }]}
                      numberOfLines={1}
                    >
                      {f.name}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {!client ? (
              <View
                style={[
                  styles.unpairedBox,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Link2 size={16} color={theme.brassText} />
                <Text style={[styles.unpairedText, { color: theme.text }]}>
                  Pair your Loop workspace to send shared links, notes, or files
                  to your agents.
                </Text>
                <Pressable
                  onPress={() => {
                    haptics.light();
                    onOpenPairing();
                  }}
                  style={[styles.pairBtn, { backgroundColor: theme.brass }]}
                >
                  <Text style={[styles.pairBtnText, { color: theme.onBrass }]}>
                    Pair workspace
                  </Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={[styles.label, { color: theme.muted }]}>
                  What should Loop do with this?
                </Text>
                <TextInput
                  value={question}
                  onChangeText={setQuestion}
                  editable={!sending && !uncertainRetryLocked}
                  placeholder="Summarize, check claims, or type @agent…"
                  placeholderTextColor={theme.muted}
                  multiline
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.surface,
                      borderColor: theme.line,
                      color: theme.text,
                      opacity: uncertainRetryLocked ? 0.65 : 1,
                    },
                  ]}
                />
                {routedNotice ? (
                  <Text style={[styles.routeHint, { color: theme.brassText }]}>
                    {routedNotice}
                  </Text>
                ) : null}

                <Text style={[styles.label, { color: theme.muted }]}>
                  Agent
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {activeAgents.map((agent) => {
                    const selected = agent.id === selectedAgentId;
                    return (
                      <Pressable
                        key={agent.id}
                        disabled={sending || uncertainRetryLocked}
                        onPress={() => {
                          haptics.selection();
                          setSelectedAgentId(agent.id);
                        }}
                        style={[
                          styles.choiceChip,
                          {
                            backgroundColor: selected
                              ? theme.attention
                              : theme.surface,
                            borderColor: selected
                              ? theme.attentionLine
                              : theme.line,
                            opacity: uncertainRetryLocked ? 0.65 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.choiceChipText,
                            { color: selected ? theme.brassText : theme.text },
                          ]}
                        >
                          @{agent.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {folders.length > 0 ? (
                  <>
                    <Text style={[styles.label, { color: theme.muted }]}>
                      Project (optional)
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.chipRow}
                    >
                      <Pressable
                        disabled={sending || uncertainRetryLocked}
                        onPress={() => {
                          haptics.selection();
                          setSelectedFolderId(null);
                        }}
                        style={[
                          styles.choiceChip,
                          {
                            backgroundColor:
                              selectedFolderId === null
                                ? theme.attention
                                : theme.surface,
                            borderColor:
                              selectedFolderId === null
                                ? theme.attentionLine
                                : theme.line,
                            opacity: uncertainRetryLocked ? 0.65 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.choiceChipText,
                            {
                              color:
                                selectedFolderId === null
                                  ? theme.brassText
                                  : theme.muted,
                            },
                          ]}
                        >
                          None
                        </Text>
                      </Pressable>
                      {folders.map((folder) => {
                        const selected = folder.id === selectedFolderId;
                        return (
                          <Pressable
                            key={folder.id}
                            disabled={sending || uncertainRetryLocked}
                            onPress={() => {
                              haptics.selection();
                              setSelectedFolderId(folder.id);
                            }}
                            style={[
                              styles.choiceChip,
                              {
                                backgroundColor: selected
                                  ? theme.attention
                                  : theme.surface,
                                borderColor: selected
                                  ? theme.attentionLine
                                  : theme.line,
                                opacity: uncertainRetryLocked ? 0.65 : 1,
                              },
                            ]}
                          >
                            <Folder
                              size={12}
                              color={selected ? theme.brassText : theme.muted}
                            />
                            <Text
                              style={[
                                styles.choiceChipText,
                                {
                                  color: selected
                                    ? theme.brassText
                                    : theme.text,
                                },
                              ]}
                            >
                              {folder.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </>
                ) : null}

                {error ? (
                  <Text style={[styles.errorText, { color: theme.orange }]}>
                    {error}
                  </Text>
                ) : null}

                {uncertainRetryLocked ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Clear locked request and start fresh"
                    disabled={sending}
                    onPress={() => {
                      haptics.warning();
                      handleResetPendingLock();
                    }}
                    style={[
                      styles.startFreshBtn,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                        opacity: sending ? 0.5 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.startFreshText, { color: theme.muted }]}
                    >
                      Already checked Feed? Start fresh
                    </Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </ScrollView>

          {client ? (
            <View style={[styles.footer, { borderTopColor: theme.line }]}>
              <Pressable
                disabled={sending}
                onPress={onClose}
                style={[
                  styles.cancelBtn,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                    opacity: sending ? 0.45 : 1,
                  },
                ]}
              >
                <Text style={[styles.cancelText, { color: theme.muted }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                disabled={
                  sending || !pendingLoaded || activeAgents.length === 0
                }
                onPress={() => void handleSend()}
                style={[
                  styles.sendBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity:
                      sending || !pendingLoaded || activeAgents.length === 0
                        ? 0.55
                        : 1,
                  },
                ]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={theme.onBrass} />
                ) : (
                  <>
                    <Send size={14} color={theme.onBrass} />
                    <Text style={[styles.sendText, { color: theme.onBrass }]}>
                      {uncertainRetryLocked ? "Retry safely" : "Send to Loop"}
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.52)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: "86%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    maxHeight: 440,
  },
  bodyContent: {
    padding: 16,
    gap: 10,
  },
  previewCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  previewHost: {
    fontSize: 12.5,
    fontWeight: "700",
    flex: 1,
  },
  previewUrl: {
    fontSize: 12,
  },
  previewText: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  fileChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: "100%",
  },
  fileChipText: {
    fontSize: 12.5,
    fontWeight: "600",
    maxWidth: 220,
  },
  unpairedBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
    alignItems: "flex-start",
  },
  unpairedText: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  pairBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  pairBtnText: {
    fontSize: 13,
    fontWeight: "700",
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 72,
    fontSize: 14.5,
    textAlignVertical: "top",
  },
  routeHint: {
    fontSize: 12,
    fontWeight: "600",
  },
  chipRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
  },
  choiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  choiceChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  errorText: {
    fontSize: 12.5,
    fontWeight: "600",
    marginTop: 4,
  },
  startFreshBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 2,
  },
  startFreshText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: {
    fontSize: 14,
    fontWeight: "600",
  },
  sendBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  sendText: {
    fontSize: 14,
    fontWeight: "700",
  },
});
