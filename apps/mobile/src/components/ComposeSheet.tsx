import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { ArrowUp, Clock, Cpu, Paperclip, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isUncertainOutcomeError,
  LoopApiError,
  randomUuid,
  type LoopClient,
} from "../api/client";
import type { ApiAgent, ApiConnection } from "../api/types";
import {
  clearDraft,
  draftScopeForCompose,
  loadDraftEntry,
  saveDraft,
  saveDraftAndFlush,
  settlePendingAgentCreate,
  type PendingAgentCreate,
} from "../drafts";
import { haptics } from "../haptics";
import {
  agentModelLabel,
  connectedHarnesses,
  defaultModelFor,
  effortLabel,
  type AgentModelSelection,
} from "../models";
import type { LoopTheme } from "../theme";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
import { AgentModelSheet } from "./AgentModelSheet";
import { ScheduleSendSheet } from "./ScheduleSendSheet";
import { VoiceRecorderButton } from "./VoiceRecorder";

/** Where a compose sheet sends: a message to one agent (opened from that
 * agent's profile) or the first task of a new agent (opened from the feed or
 * a project). */
export type ComposeTarget =
  | { kind: "agent"; agent: ApiAgent }
  | { kind: "new"; folderId?: string | null; folderName?: string };

export type ComposeSubmit = {
  text: string;
  attachmentIds?: string[];
  idempotencyKey: string;
};

export function ComposeSheet({
  theme,
  client,
  connections,
  target,
  onClose,
  onMessage,
  onSchedule,
  onCreate,
}: {
  theme: LoopTheme;
  client: LoopClient | null;
  connections: ApiConnection[];
  target: ComposeTarget;
  onClose: () => void;
  onMessage: (agent: ApiAgent, input: ComposeSubmit) => Promise<void>;
  onSchedule?: (
    agent: ApiAgent,
    input: ComposeSubmit & { sendAt: number; folderId?: string | null },
  ) => Promise<void>;
  onCreate: (input: PendingAgentCreate) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const agent = target.kind === "agent" ? target.agent : null;
  const agentId = agent?.id;
  const folderId =
    target.kind === "agent"
      ? (target.agent.folder_id ?? null)
      : (target.folderId ?? null);
  const harnesses = useMemo(
    () => connectedHarnesses(connections),
    [connections],
  );
  const [modelSelection, setModelSelection] =
    useState<AgentModelSelection | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingAgentCreate | null>(
    null,
  );
  const [draftLoaded, setDraftLoaded] = useState(false);
  const defaultConnection = harnesses[0];
  const selection = pendingCreate ??
    modelSelection ?? {
      connectionId: defaultConnection?.id ?? "",
      model: defaultConnection ? defaultModelFor(defaultConnection) : "",
      effort: null,
    };
  // One name per sheet: a retry after an uncertain create must send the same
  // name with the same key so the server returns the agent it already made.
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [hasPendingSend, setHasPendingSend] = useState(false);
  const [pendingSchedule, setPendingSchedule] = useState<{
    idempotencyKey: string;
    sendAt: number;
    input: string;
    folderId: string | null;
    attachmentIds: string[];
    locked: boolean;
  } | null>(null);
  const draftScope = useMemo(
    () => draftScopeForCompose(agent?.id, folderId),
    [agent?.id, folderId],
  );
  const draftTouchedRef = useRef(false);
  const restoredPendingKeyRef = useRef<string | null>(null);
  const restoredPendingScheduleRef = useRef<{
    idempotencyKey: string;
    sendAt: number;
    input: string;
    folderId: string | null;
    attachmentIds: string[];
    locked: boolean;
  } | null>(null);

  const sendKeyRef = useRef<string | null>(null);
  const composeAttachments = useAttachments(client, {
    agentId: agent?.id,
    folderId,
  });

  const { restoreUploadedAttachments } = composeAttachments;

  useEffect(() => {
    let cancelled = false;
    draftTouchedRef.current = false;
    void loadDraftEntry(client?.localDataScope, draftScope).then((entry) => {
      if (cancelled) return;
      setDraftLoaded(true);
      if (!entry?.text) return;
      if (!agentId && entry.pendingAgentCreate) {
        const pending = entry.pendingAgentCreate;
        setPendingCreate(pending);
        restoreUploadedAttachments(pending.attachmentIds);
        setName(pending.name);
        setModelSelection({
          connectionId: pending.connectionId,
          model: pending.model,
          effort: pending.effort,
        });
        setText(entry.text);
        return;
      }
      if (entry.pendingSchedule) {
        // Always restore a locked schedule even if the user started typing before disk load finished.
        const restored = {
          idempotencyKey: entry.pendingSchedule.key,
          sendAt: entry.pendingSchedule.sendAt,
          input: entry.pendingSchedule.input ?? entry.text,
          folderId:
            entry.pendingSchedule.folderId !== undefined
              ? entry.pendingSchedule.folderId
              : (agent?.folder_id ?? null),
          attachmentIds: entry.pendingSchedule.attachmentIds ?? [],
          locked: true,
        };
        restoredPendingScheduleRef.current = restored;
        setPendingSchedule(restored);
        setText(entry.text);
        return;
      }
      if (!draftTouchedRef.current) {
        restoredPendingKeyRef.current = entry.pendingKey ?? null;
        setText(entry.text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    agentId,
    agent?.folder_id,
    client?.localDataScope,
    draftScope,
    restoreUploadedAttachments,
  ]);

  useEffect(() => {
    if (agent || !client) return;
    let cancelled = false;
    client
      .suggestAgentName()
      .then((suggested) => {
        if (!cancelled) setName((prev) => prev || suggested);
      })
      .catch(() => {
        if (!cancelled) setError("Could not pick a name for the new agent.");
      });
    return () => {
      cancelled = true;
    };
  }, [agent, client]);

  const attSig = composeAttachments.readyIds.join(",");
  useEffect(() => {
    setScheduleError("");
    if (restoredPendingScheduleRef.current) {
      setPendingSchedule(restoredPendingScheduleRef.current);
      restoredPendingScheduleRef.current = null;
    } else {
      setPendingSchedule((prev) => (prev?.locked ? prev : null));
    }
    if (restoredPendingKeyRef.current) {
      sendKeyRef.current = restoredPendingKeyRef.current;
      restoredPendingKeyRef.current = null;
      setHasPendingSend(true);
      return;
    }
    sendKeyRef.current = null;
    setHasPendingSend(false);
  }, [text, attSig]);

  const scheduleLocked = Boolean(pendingSchedule?.locked);
  const createLocked = Boolean(pendingCreate);
  const composerLocked = scheduleLocked || createLocked;
  const ready = agent
    ? true
    : client
      ? draftLoaded &&
        Boolean(
          pendingCreate || (name && selection.connectionId && selection.model),
        )
      : true;
  const cannotSend =
    (!pendingCreate &&
      !text.trim() &&
      composeAttachments.readyIds.length === 0) ||
    composeAttachments.uploading ||
    composeAttachments.hasErrors ||
    recordingAudio ||
    !ready ||
    busy ||
    scheduleBusy ||
    Boolean(pendingSchedule);
  const canSchedule = Boolean(
    agent &&
    client &&
    onSchedule &&
    (Boolean(text.trim()) ||
      composeAttachments.readyIds.length > 0 ||
      Boolean(pendingSchedule)) &&
    !composeAttachments.uploading &&
    (!composeAttachments.hasErrors || Boolean(pendingSchedule)) &&
    !recordingAudio &&
    ready &&
    !busy &&
    !scheduleBusy &&
    !hasPendingSend,
  );

  async function handleSchedule(sendAt: number) {
    if (!agent || !onSchedule || scheduleBusy || busy) return;
    const trimmed = text.trim();
    const { readyIds, readyNames, uploading, hasErrors, clearAttachments } =
      composeAttachments;
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
      folderId: agent.folder_id ?? null,
      attachmentIds: readyIds,
      locked: false,
    };
    setScheduleBusy(true);
    setScheduleError("");
    // Persist and flush durable schedule identity + payload before dispatch;
    // refuse to dispatch if local persistence fails.
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
            agentId: agent.id,
            folderId: nextPending.folderId,
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
      await onSchedule(agent, {
        text: nextPending.input,
        folderId: nextPending.folderId,
        attachmentIds: nextPending.attachmentIds,
        idempotencyKey: nextPending.idempotencyKey,
        sendAt: nextPending.sendAt,
      });
      setPendingSchedule(null);
      setScheduleOpen(false);
      sendKeyRef.current = null;
      setHasPendingSend(false);
      clearDraft(client?.localDataScope, draftScope);
      clearAttachments();
      onClose();
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
        if (text.trim()) saveDraft(client?.localDataScope, draftScope, text);
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

  async function handleSend() {
    const trimmed = text.trim();
    const { readyIds, readyNames, clearAttachments } = composeAttachments;
    if (cannotSend || sendingRef.current) return;
    const finalText =
      trimmed ||
      (readyNames.length === 1
        ? `Attached ${readyNames[0]}`
        : `Attached ${readyNames.length} files`);
    if (!sendKeyRef.current) sendKeyRef.current = randomUuid();
    const idempotencyKey = pendingCreate?.idempotencyKey ?? sendKeyRef.current;
    sendingRef.current = true;
    haptics.medium();
    setBusy(true);
    setError("");
    let dispatched = false;
    try {
      if (agent) {
        dispatched = true;
        await onMessage(agent, {
          text: finalText,
          attachmentIds: readyIds,
          idempotencyKey,
        });
      } else {
        const creation = pendingCreate ?? {
          ...selection,
          text: finalText,
          attachmentIds: readyIds,
          idempotencyKey,
          name: name || "agent",
          folderId,
        };
        if (client && !pendingCreate) {
          await saveDraftAndFlush(
            client.localDataScope,
            draftScope,
            text.trim() || finalText,
            {
              agentCreate: creation,
            },
          );
          setPendingCreate(creation);
        }
        dispatched = true;
        await onCreate(creation);
      }
      sendKeyRef.current = null;
      if (!agent && client) {
        const settled = settlePendingAgentCreate(
          client.localDataScope,
          draftScope,
          idempotencyKey,
        );
        if (settled === "write-failed") {
          setError(
            "Agent started, but the recovery record could not be cleared. Retry to confirm the same request.",
          );
        }
        if (settled !== "settled") return;
      } else {
        clearDraft(client?.localDataScope, draftScope);
      }
      clearAttachments();
      onClose();
    } catch (err) {
      if (err instanceof LoopApiError && err.status === 401) return;
      if (dispatched && isUncertainOutcomeError(err)) {
        if (agent) {
          setHasPendingSend(true);
          saveDraft(client?.localDataScope, draftScope, text, {
            key: idempotencyKey,
          });
        }
      } else if (dispatched && pendingCreate) {
        // A new rejection does not establish the outcome of an earlier timed-out POST.
        setError(
          "Creation is still unconfirmed. Check the Feed before discarding the recovery record.",
        );
        return;
      } else if (dispatched) {
        sendKeyRef.current = null;
        setHasPendingSend(false);
        if (!agent) {
          if (client) {
            const settled = settlePendingAgentCreate(
              client.localDataScope,
              draftScope,
              idempotencyKey,
              text.trim() || finalText,
            );
            if (settled === "write-failed") {
              setError(
                "Could not update the recovery record. Retry to check the same request.",
              );
            }
            if (settled !== "settled") return;
          }
          setPendingCreate(null);
        }
      }
      haptics.warning();
      setError(
        err instanceof Error
          ? err.message
          : agent
            ? "Could not send message."
            : "Could not start the agent.",
      );
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  function confirmDiscardCreation() {
    if (!client || !pendingCreate || sendingRef.current) return;
    Alert.alert(
      "Discard creation recovery?",
      "The agent may already have started. Check the Feed before sending this draft again.",
      [
        { text: "Keep recovery", style: "cancel" },
        {
          text: "Discard recovery",
          style: "destructive",
          onPress: () => {
            const settled = settlePendingAgentCreate(
              client.localDataScope,
              draftScope,
              pendingCreate.idempotencyKey,
              text || pendingCreate.text,
            );
            if (settled === "write-failed")
              setError("Could not clear the recovery record. Try again.");
            if (settled !== "settled") return;
            sendKeyRef.current = null;
            setPendingCreate(null);
            setError("");
          },
        },
      ],
    );
  }

  const title = agent
    ? `Message @${agent.name}`
    : name
      ? `New agent @${name}`
      : "New agent";
  const subtitle = agent
    ? agentModelLabel(agent, connections)
    : target.kind === "new" && target.folderName
      ? `In ${target.folderName}`
      : "";

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (!busy && !scheduleBusy) onClose();
        }}
      >
        <BlurView
          intensity={56}
          tint={theme.blurTint}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
      </Pressable>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.sheetSpacer} pointerEvents="box-none">
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: theme.surface,
                borderColor: theme.line,
                paddingBottom: Math.max(insets.bottom + 14, 22),
              },
            ]}
          >
            <View style={styles.head}>
              <View style={styles.headText}>
                <Text
                  style={[styles.title, { color: theme.text }]}
                  numberOfLines={1}
                >
                  {title}
                </Text>
                {subtitle ? (
                  <Text
                    style={[styles.subtitle, { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <Pressable
                disabled={busy || scheduleBusy}
                onPress={() => {
                  if (busy || scheduleBusy) return;
                  haptics.light();
                  onClose();
                }}
                style={[
                  styles.closeBtn,
                  {
                    backgroundColor: theme.soft,
                    borderColor: theme.line,
                    opacity: busy || scheduleBusy ? 0.4 : 1,
                  },
                ]}
              >
                <X size={16} color={theme.text} />
              </Pressable>
            </View>

            {!agent && client && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose model and effort"
                disabled={busy || createLocked || harnesses.length === 0}
                onPress={() => {
                  Keyboard.dismiss();
                  setModelPickerOpen(true);
                }}
                style={[
                  styles.modelButton,
                  { backgroundColor: theme.soft, borderColor: theme.line },
                ]}
              >
                <Cpu size={16} color={theme.brassText} />
                <Text style={[styles.modelButtonText, { color: theme.text }]}>
                  {selection.model
                    ? agentModelLabel(
                        {
                          connection_id: selection.connectionId,
                          model: selection.model,
                        },
                        connections,
                      )
                    : "Choose model"}
                  {" · "}
                  {effortLabel(selection.effort)}
                </Text>
              </Pressable>
            )}

            <AttachmentChipStrip
              attachments={composeAttachments.attachments}
              theme={theme}
              locked={composerLocked || busy}
              onRemove={composeAttachments.removeAttachment}
              onRetry={(id) => void composeAttachments.retryAttachment(id)}
            />

            {/* Prompt Input */}
            <View
              style={[
                styles.composerBox,
                { backgroundColor: theme.soft, borderColor: theme.line },
              ]}
            >
              <Pressable
                accessibilityLabel="Attach photo or file"
                disabled={
                  !composeAttachments.canAddMore ||
                  busy ||
                  scheduleBusy ||
                  composerLocked
                }
                onPress={() => {
                  haptics.light();
                  Keyboard.dismiss();
                  composeAttachments.setPickerOpen(true);
                }}
                style={[
                  styles.attachBtn,
                  (!composeAttachments.canAddMore ||
                    busy ||
                    scheduleBusy ||
                    composerLocked) && {
                    opacity: 0.4,
                  },
                ]}
              >
                <Paperclip
                  size={18}
                  color={
                    composeAttachments.attachments.length > 0
                      ? theme.brassText
                      : theme.muted
                  }
                />
              </Pressable>
              <VoiceRecorderButton
                theme={theme}
                disabled={
                  !composeAttachments.canAddMore ||
                  busy ||
                  scheduleBusy ||
                  composerLocked
                }
                onRecordingChange={setRecordingAudio}
                onRecorded={(file) => {
                  setError("");
                  void composeAttachments.addFiles([file]);
                }}
                onError={(msg) => setError(msg)}
              />
              <TextInput
                value={text}
                editable={!busy && !scheduleBusy && !composerLocked}
                onChangeText={(next) => {
                  draftTouchedRef.current = true;
                  sendKeyRef.current = null;
                  setText(next);
                  saveDraft(client?.localDataScope, draftScope, next);
                }}
                placeholder={
                  agent ? `Message @${agent.name}…` : "What should it do?"
                }
                placeholderTextColor={theme.muted}
                style={[styles.input, { color: theme.text }]}
                multiline
                maxLength={30_000}
                autoFocus
              />
              {agent && client && onSchedule && (
                <Pressable
                  accessibilityLabel="Schedule message"
                  disabled={!canSchedule}
                  onPress={() => {
                    haptics.light();
                    Keyboard.dismiss();
                    setScheduleError("");
                    setScheduleOpen(true);
                  }}
                  style={[styles.attachBtn, !canSchedule && { opacity: 0.35 }]}
                >
                  <Clock
                    size={17}
                    color={pendingSchedule ? theme.brassText : theme.muted}
                  />
                </Pressable>
              )}
              <Pressable
                accessibilityLabel={
                  agent
                    ? "Send"
                    : createLocked
                      ? "Retry starting agent"
                      : "Start agent"
                }
                disabled={cannotSend}
                onPress={() => void handleSend()}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity: cannotSend ? 0.35 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={theme.onBrass} />
                ) : (
                  <ArrowUp size={18} color={theme.onBrass} strokeWidth={2.5} />
                )}
              </Pressable>
            </View>

            {createLocked && !busy && (
              <>
                <Text style={{ color: theme.muted }}>
                  Retry to check whether this agent was started.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={confirmDiscardCreation}
                >
                  <Text style={{ color: theme.brassText }}>
                    Discard recovery record
                  </Text>
                </Pressable>
              </>
            )}

            {error ? (
              <Text style={[styles.errorText, { color: theme.orange }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>

      {modelPickerOpen && (
        <AgentModelSheet
          initialSelection={selection}
          connections={connections}
          theme={theme}
          confirmLabel="Use model and effort"
          onClose={() => setModelPickerOpen(false)}
          onSave={(next) => {
            sendKeyRef.current = null;
            setModelSelection(next);
          }}
        />
      )}

      <AttachmentSourceSheet
        visible={composeAttachments.pickerOpen}
        theme={theme}
        onClose={() => composeAttachments.setPickerOpen(false)}
        onPickPhotos={() => void composeAttachments.pickFromPhotos()}
        onTakePhoto={() => void composeAttachments.takePhoto()}
        onPickFile={() => void composeAttachments.pickDocument()}
      />

      {agent && (
        <ScheduleSendSheet
          visible={scheduleOpen}
          theme={theme}
          agentName={agent.name}
          previewText={text}
          attachmentCount={
            pendingSchedule
              ? pendingSchedule.attachmentIds.length
              : composeAttachments.readyIds.length
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
            if (text.trim())
              saveDraft(client?.localDataScope, draftScope, text);
            else clearDraft(client?.localDataScope, draftScope);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetSpacer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headText: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 12.5,
    marginTop: 2,
  },
  modelButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  modelButtonText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  composerBox: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderRadius: 20,
    borderWidth: 1,
    paddingLeft: 8,
    paddingRight: 7,
    paddingVertical: 7,
  },
  attachBtn: {
    width: 34,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 44,
    maxHeight: 140,
    paddingVertical: 4,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: 13,
  },
});
