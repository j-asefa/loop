import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { ArrowUp, Clock, Paperclip, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isUncertainOutcomeError,
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
} from "../drafts";
import { haptics } from "../haptics";
import {
  agentModelLabel,
  connectedHarnesses,
  defaultModelFor,
  harnessLabel,
} from "../models";
import type { LoopTheme } from "../theme";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
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
    input: ComposeSubmit & { sendAt: number },
  ) => Promise<void>;
  onCreate: (
    input: ComposeSubmit & {
      name: string;
      connectionId: string;
      model: string;
      folderId?: string | null;
    },
  ) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const agent = target.kind === "agent" ? target.agent : null;
  const folderId =
    target.kind === "agent"
      ? (target.agent.folder_id ?? null)
      : (target.folderId ?? null);
  const harnesses = useMemo(
    () => connectedHarnesses(connections),
    [connections],
  );
  const [connectionId, setConnectionId] = useState(harnesses[0]?.id ?? "");
  const connection =
    harnesses.find((c) => c.id === connectionId) ?? harnesses[0];
  const model = connection ? defaultModelFor(connection) : "";
  // One name per sheet: a retry after an uncertain create must send the same
  // name with the same key so the server returns the agent it already made.
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
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
    attachmentIds: string[];
    locked: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    draftTouchedRef.current = false;
    void loadDraftEntry(client?.origin, draftScope).then((entry) => {
      if (!cancelled && !draftTouchedRef.current && entry?.text) {
        restoredPendingKeyRef.current = entry.pendingKey ?? null;
        restoredPendingScheduleRef.current = entry.pendingSchedule
          ? {
              idempotencyKey: entry.pendingSchedule.key,
              sendAt: entry.pendingSchedule.sendAt,
              input: entry.pendingSchedule.input ?? entry.text,
              attachmentIds: entry.pendingSchedule.attachmentIds ?? [],
              locked: true,
            }
          : null;
        setText(entry.text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client?.origin, draftScope]);

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

  const sendKeyRef = useRef<string | null>(null);
  const composeAttachments = useAttachments(client, {
    agentId: agent?.id,
    folderId,
  });

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

  // Only new-agent creation depends on connection?.id; existing-agent schedules must not reset on connection list refreshes.
  useEffect(() => {
    if (agent) return;
    sendKeyRef.current = null;
    setHasPendingSend(false);
  }, [agent, connection?.id]);

  const scheduleLocked = Boolean(pendingSchedule?.locked);
  const ready = agent
    ? true
    : client
      ? Boolean(name && connection && model)
      : true;
  const cannotSend =
    (!text.trim() && composeAttachments.readyIds.length === 0) ||
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
      attachmentIds: readyIds,
      locked: false,
    };
    setPendingSchedule(nextPending);
    setScheduleBusy(true);
    setScheduleError("");
    // Persist and flush durable schedule identity + payload before dispatch so
    // process kills or uncertain timeouts never replay under a second key.
    await saveDraftAndFlush(client?.origin, draftScope, trimmed || finalText, {
      schedule: {
        key: nextPending.idempotencyKey,
        sendAt: nextPending.sendAt,
        input: nextPending.input,
        attachmentIds: nextPending.attachmentIds,
      },
    });
    try {
      await onSchedule(agent, {
        text: nextPending.input,
        attachmentIds: nextPending.attachmentIds,
        idempotencyKey: nextPending.idempotencyKey,
        sendAt: nextPending.sendAt,
      });
      setPendingSchedule(null);
      setScheduleOpen(false);
      sendKeyRef.current = null;
      setHasPendingSend(false);
      clearDraft(client?.origin, draftScope);
      clearAttachments();
      onClose();
    } catch (err) {
      if (isUncertainOutcomeError(err)) {
        setPendingSchedule({ ...nextPending, locked: true });
      } else {
        setPendingSchedule(null);
        if (text.trim()) saveDraft(client?.origin, draftScope, text);
        else clearDraft(client?.origin, draftScope);
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
    if (cannotSend) return;
    const finalText =
      trimmed ||
      (readyNames.length === 1
        ? `Attached ${readyNames[0]}`
        : `Attached ${readyNames.length} files`);
    if (!sendKeyRef.current) sendKeyRef.current = randomUuid();
    const idempotencyKey = sendKeyRef.current;
    haptics.medium();
    setBusy(true);
    setError("");
    try {
      const input = {
        text: finalText,
        attachmentIds: readyIds,
        idempotencyKey,
      };
      if (agent) await onMessage(agent, input);
      else
        await onCreate({
          ...input,
          name: name || "agent",
          connectionId: connection?.id ?? "",
          model,
          folderId,
        });
      sendKeyRef.current = null;
      clearDraft(client?.origin, draftScope);
      clearAttachments();
      onClose();
    } catch (err) {
      if (isUncertainOutcomeError(err)) {
        setHasPendingSend(true);
        saveDraft(client?.origin, draftScope, text, { key: idempotencyKey });
      } else {
        sendKeyRef.current = null;
        setHasPendingSend(false);
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
      setBusy(false);
    }
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

            {/* A new agent needs only its harness; shown when there is a choice. */}
            {!agent && harnesses.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.pillRail}
              >
                {harnesses.map((c) => {
                  const active = c.id === connection?.id;
                  return (
                    <Pressable
                      key={c.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => {
                        haptics.selection();
                        setConnectionId(c.id);
                      }}
                      style={[
                        styles.harnessChip,
                        {
                          backgroundColor: active
                            ? theme.attention
                            : theme.soft,
                          borderColor: active ? theme.brass : theme.line,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.harnessChipText,
                          { color: active ? theme.brassText : theme.muted },
                        ]}
                      >
                        {harnessLabel(c)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            <AttachmentChipStrip
              attachments={composeAttachments.attachments}
              theme={theme}
              locked={scheduleLocked}
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
                  scheduleLocked
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
                    scheduleLocked) && {
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
                  scheduleLocked
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
                editable={!busy && !scheduleBusy && !scheduleLocked}
                onChangeText={(next) => {
                  draftTouchedRef.current = true;
                  sendKeyRef.current = null;
                  setText(next);
                  saveDraft(client?.origin, draftScope, next);
                }}
                placeholder={
                  agent ? `Message @${agent.name}…` : "What should it do?"
                }
                placeholderTextColor={theme.muted}
                style={[styles.input, { color: theme.text }]}
                multiline
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
                accessibilityLabel={agent ? "Send" : "Start agent"}
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

            {error ? (
              <Text style={[styles.errorText, { color: theme.orange }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>

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
            if (text.trim()) saveDraft(client?.origin, draftScope, text);
            else clearDraft(client?.origin, draftScope);
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
  harnessChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  harnessChipText: {
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
  pillRail: {
    gap: 8,
    paddingRight: 16,
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
