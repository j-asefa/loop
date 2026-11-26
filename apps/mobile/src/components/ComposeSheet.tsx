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
import { ArrowUp, Folder, Paperclip, Sparkles, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { randomUuid, type LoopClient } from "../api/client";
import type { ApiAgent, ApiFolder, ApiSnippet } from "../api/types";
import { QUICK_REPLIES } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
import { AgentAvatar } from "./RichContent";

export function ComposeSheet({
  theme,
  client,
  agents,
  folders,
  snippets,
  defaultAgentId,
  defaultFolderId,
  onClose,
  onSend,
}: {
  theme: LoopTheme;
  client: LoopClient | null;
  agents: ApiAgent[];
  folders: ApiFolder[];
  snippets: ApiSnippet[];
  defaultAgentId?: string;
  defaultFolderId?: string | null;
  onClose: () => void;
  onSend: (input: {
    agentId: string;
    agentName: string;
    folderId?: string | null;
    text: string;
    attachmentIds?: string[];
    idempotencyKey?: string;
  }) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const activeAgents = useMemo(
    () => agents.filter((a) => !a.retired_at),
    [agents],
  );
  const [selectedAgentId, setSelectedAgentId] = useState(
    defaultAgentId || activeAgents[0]?.id || "",
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(
    defaultFolderId ?? null,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedAgent =
    activeAgents.find((a) => a.id === selectedAgentId) ?? activeAgents[0];

  const sendKeyRef = useRef<string | null>(null);
  const composeAttachments = useAttachments(client, {
    agentId: selectedAgent?.id,
    folderId: selectedFolderId,
  });

  const attSig = composeAttachments.readyIds.join(",");
  useEffect(() => {
    sendKeyRef.current = null;
  }, [text, selectedAgent?.id, selectedFolderId, attSig]);

  const projects = useMemo(
    () => folders.filter((f) => f.kind === "project" || f.is_workspace),
    [folders],
  );

  async function handleSend() {
    const trimmed = text.trim();
    const { readyIds, readyNames, uploading, clearAttachments } =
      composeAttachments;
    if (
      (!trimmed && readyIds.length === 0) ||
      uploading ||
      !selectedAgent ||
      busy
    ) {
      return;
    }
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
      await onSend({
        agentId: selectedAgent.id,
        agentName: selectedAgent.name,
        folderId: selectedFolderId,
        text: finalText,
        attachmentIds: readyIds,
        idempotencyKey,
      });
      sendKeyRef.current = null;
      clearAttachments();
      onClose();
    } catch (err) {
      haptics.warning();
      setError(err instanceof Error ? err.message : "Could not send task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          if (!busy) onClose();
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
              <Text style={[styles.title, { color: theme.text }]}>
                New task
              </Text>
              <Pressable
                onPress={() => {
                  haptics.light();
                  onClose();
                }}
                style={[
                  styles.closeBtn,
                  { backgroundColor: theme.soft, borderColor: theme.line },
                ]}
              >
                <X size={16} color={theme.text} />
              </Pressable>
            </View>

            {/* Agent Selector Rail */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillRail}
            >
              {activeAgents.map((agent) => {
                const active = agent.id === selectedAgent?.id;
                return (
                  <Pressable
                    key={agent.id}
                    onPress={() => {
                      haptics.selection();
                      setSelectedAgentId(agent.id);
                    }}
                    style={[
                      styles.agentPill,
                      {
                        backgroundColor: active ? theme.attention : theme.soft,
                        borderColor: active ? theme.brass : theme.line,
                      },
                    ]}
                  >
                    <AgentAvatar name={agent.name} size={22} />
                    <View>
                      <Text
                        style={[
                          styles.agentName,
                          { color: active ? theme.brassText : theme.text },
                        ]}
                      >
                        @{agent.name}
                      </Text>
                      <Text
                        style={[styles.agentModel, { color: theme.muted }]}
                        numberOfLines={1}
                      >
                        {agent.model}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Project Picker Rail */}
            {projects.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pillRail}
              >
                {projects.map((proj) => {
                  const active = selectedFolderId === proj.id;
                  return (
                    <Pressable
                      key={proj.id}
                      onPress={() => {
                        haptics.selection();
                        setSelectedFolderId(active ? null : proj.id);
                      }}
                      style={[
                        styles.projectChip,
                        {
                          backgroundColor: active
                            ? theme.attention
                            : theme.soft,
                          borderColor: active
                            ? theme.attentionLine
                            : theme.line,
                        },
                      ]}
                    >
                      <Folder
                        size={12}
                        color={active ? theme.brassText : theme.muted}
                      />
                      <Text
                        style={[
                          styles.projectChipText,
                          { color: active ? theme.brassText : theme.muted },
                        ]}
                      >
                        {proj.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            {/* Quick Snippets Rail */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pillRail}
            >
              {snippets.slice(0, 5).map((snip) => (
                <Pressable
                  key={snip.id}
                  onPress={() => {
                    haptics.light();
                    setText((prev) =>
                      prev.trim()
                        ? `${prev.trim()}\n\n${snip.content}`
                        : snip.content,
                    );
                  }}
                  style={[
                    styles.snippetChip,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  <Sparkles size={11} color={theme.brassText} />
                  <Text
                    style={[styles.snippetText, { color: theme.text }]}
                    numberOfLines={1}
                  >
                    /{snip.title}
                  </Text>
                </Pressable>
              ))}
              {snippets.length === 0 &&
                QUICK_REPLIES.map((opt) => (
                  <Pressable
                    key={opt.id}
                    onPress={() => {
                      haptics.light();
                      setText(opt.instruction);
                    }}
                    style={[
                      styles.snippetChip,
                      { backgroundColor: theme.soft, borderColor: theme.line },
                    ]}
                  >
                    <Sparkles size={11} color={theme.brassText} />
                    <Text style={[styles.snippetText, { color: theme.text }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
            </ScrollView>

            <AttachmentChipStrip
              attachments={composeAttachments.attachments}
              theme={theme}
              onRemove={composeAttachments.removeAttachment}
            />

            {/* Prompt Input */}
            <View
              style={[
                styles.composerBox,
                { backgroundColor: theme.bg, borderColor: theme.line },
              ]}
            >
              <Pressable
                accessibilityLabel="Attach photo or file"
                disabled={!composeAttachments.canAddMore}
                onPress={() => {
                  haptics.light();
                  Keyboard.dismiss();
                  composeAttachments.setPickerOpen(true);
                }}
                style={[
                  styles.attachBtn,
                  !composeAttachments.canAddMore && { opacity: 0.4 },
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
              <TextInput
                value={text}
                onChangeText={(next) => {
                  sendKeyRef.current = null;
                  setText(next);
                }}
                placeholder={
                  selectedAgent
                    ? `Ask @${selectedAgent.name} anything…`
                    : "Write a task…"
                }
                placeholderTextColor={theme.muted}
                style={[styles.input, { color: theme.text }]}
                multiline
                autoFocus
              />
              <Pressable
                disabled={
                  (!text.trim() && composeAttachments.readyIds.length === 0) ||
                  composeAttachments.uploading ||
                  !selectedAgent ||
                  busy
                }
                onPress={() => void handleSend()}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity:
                      (!text.trim() &&
                        composeAttachments.readyIds.length === 0) ||
                      composeAttachments.uploading ||
                      !selectedAgent ||
                      busy
                        ? 0.35
                        : pressed
                          ? 0.85
                          : 1,
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
  title: {
    fontSize: 18,
    fontWeight: "700",
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
  agentPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 14,
    borderWidth: 1,
  },
  agentName: {
    fontSize: 13,
    fontWeight: "700",
  },
  agentModel: {
    fontSize: 10.5,
    maxWidth: 110,
  },
  projectChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  projectChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  snippetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 180,
  },
  snippetText: {
    fontSize: 12,
    fontWeight: "600",
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
