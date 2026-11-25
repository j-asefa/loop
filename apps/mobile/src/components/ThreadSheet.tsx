import React, { useCallback, useEffect, useRef, useState } from "react";
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
import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  Paperclip,
  Sparkles,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import type { ApiMessage } from "../api/types";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import {
  AttachmentChipStrip,
  AttachmentSourceSheet,
  useAttachments,
} from "./AttachmentTray";
import { AgentAvatar, RichContent } from "./RichContent";

export function ThreadSheet({
  conversationId,
  title,
  agentName,
  agentId,
  client,
  fallbackCards,
  theme,
  onClose,
  onSendLiveReply,
  onToggleSaved,
}: {
  conversationId: string;
  title: string;
  agentName: string;
  agentId?: string | null;
  client: LoopClient | null;
  fallbackCards?: NativeResultCard[];
  theme: LoopTheme;
  onClose: () => void;
  onSendLiveReply: (input: {
    conversationId: string;
    agentId: string;
    agentName: string;
    text: string;
    attachmentIds?: string[];
  }) => Promise<void>;
  onToggleSaved: (messageId: string, currentlySaved: boolean) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [resolvedTitle, setResolvedTitle] = useState(title);
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(
    agentId ?? null,
  );
  const [loading, setLoading] = useState(Boolean(client));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const replyAttachments = useAttachments(client, {
    agentId: resolvedAgentId,
  });

  const load = useCallback(async () => {
    if (!client) {
      // Build chronological messages from local demo cards
      const chron = [...(fallbackCards ?? [])].reverse();
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

    setLoading(true);
    setError("");
    try {
      const page = await client.conversation(conversationId);
      setMessages(page.messages);
      setSavedIds(new Set(page.saved));
      setWorking(page.working);
      if (page.conversation.title) setResolvedTitle(page.conversation.title);
      if (page.conversation.agent_id) {
        setResolvedAgentId(page.conversation.agent_id);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load conversation.",
      );
    } finally {
      setLoading(false);
    }
  }, [client, conversationId, fallbackCards]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSend() {
    const trimmed = draft.trim();
    const { readyIds, readyNames, uploading, clearAttachments } =
      replyAttachments;
    if ((!trimmed && readyIds.length === 0) || uploading || sending) return;
    const finalText =
      trimmed ||
      (readyNames.length === 1
        ? `Attached ${readyNames[0]}`
        : `Attached ${readyNames.length} files`);
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
      });
      setDraft("");
      clearAttachments();
      if (client) {
        setTimeout(() => void load(), 500);
      }
    } catch (err) {
      haptics.warning();
      setError(err instanceof Error ? err.message : "Could not send reply.");
    } finally {
      setSending(false);
    }
  }

  async function handleToggleSave(msgId: string) {
    const isSaved = savedIds.has(msgId);
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
              {working && (
                <View
                  style={[
                    styles.workingBadge,
                    { backgroundColor: theme.blueSoft },
                  ]}
                >
                  <Sparkles size={10} color={theme.blue} />
                  <Text style={[styles.workingText, { color: theme.blue }]}>
                    Working
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

        {/* Chronological Message Stream */}
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.messagesContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: false })
          }
        >
          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={theme.brass} />
            </View>
          ) : error ? (
            <Text style={[styles.errorText, { color: theme.orange }]}>
              {error}
            </Text>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === "user";
              const isSaved = savedIds.has(msg.id);
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
                    {!isUser && (
                      <Pressable
                        onPress={() => void handleToggleSave(msg.id)}
                        hitSlop={8}
                      >
                        {isSaved ? (
                          <BookmarkCheck size={15} color={theme.brassText} />
                        ) : (
                          <Bookmark size={15} color={theme.muted} />
                        )}
                      </Pressable>
                    )}
                  </View>
                  {isUser ? (
                    <Text style={[styles.userText, { color: theme.text }]}>
                      {msg.content}
                    </Text>
                  ) : (
                    <RichContent
                      content={msg.content}
                      theme={theme}
                      onReplyButton={(prompt) => setDraft(prompt)}
                    />
                  )}
                </View>
              );
            })
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
          <AttachmentChipStrip
            attachments={replyAttachments.attachments}
            theme={theme}
            onRemove={replyAttachments.removeAttachment}
          />
          <View
            style={[
              styles.composerPill,
              { backgroundColor: theme.bg, borderColor: theme.line },
            ]}
          >
            <Pressable
              accessibilityLabel="Attach photo or file"
              disabled={!replyAttachments.canAddMore}
              onPress={() => {
                haptics.light();
                Keyboard.dismiss();
                replyAttachments.setPickerOpen(true);
              }}
              style={[
                styles.attachBtn,
                !replyAttachments.canAddMore && { opacity: 0.4 },
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
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={`Reply to @${agentName}…`}
              placeholderTextColor={theme.muted}
              style={[styles.composerInput, { color: theme.text }]}
              multiline
            />
            <Pressable
              disabled={
                (!draft.trim() && replyAttachments.readyIds.length === 0) ||
                replyAttachments.uploading ||
                sending
              }
              onPress={() => void handleSend()}
              style={[
                styles.sendBtn,
                {
                  backgroundColor: theme.brass,
                  opacity:
                    (!draft.trim() && replyAttachments.readyIds.length === 0) ||
                    replyAttachments.uploading ||
                    sending
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
});
