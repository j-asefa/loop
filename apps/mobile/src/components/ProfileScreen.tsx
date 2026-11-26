import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  AlarmClock,
  ArrowUpRight,
  BookmarkCheck,
  CalendarClock,
  Check,
  FileText,
  Link2,
  LogOut,
  Moon,
  Rss,
  Sun,
  Trash2,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import {
  formatFileBytes,
  isPreviewableImageMime,
  type PublishedFileItem,
} from "../api/files";
import type { SocketStatus } from "../api/socket";
import type {
  ApiLaterItem,
  ApiPersonalProfile,
  ApiSavedEntry,
  ApiScheduledSend,
  ApiSocialStory,
  PairedSession,
} from "../api/types";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { AgentAvatar, ProfileCoverBanner } from "./RichContent";

type ProfileSection = "saved" | "reminders" | "scheduled" | "files" | "social";

const SECTIONS: Array<{ id: ProfileSection; label: string }> = [
  { id: "saved", label: "Saved" },
  { id: "reminders", label: "Reminders" },
  { id: "scheduled", label: "Scheduled" },
  { id: "files", label: "Files" },
  { id: "social", label: "Social" },
];

export function ProfileScreen({
  client,
  session,
  socketStatus,
  localCards,
  theme,
  onToggleTheme,
  onOpenPairing,
  onSignOut,
  onOpenConversation,
  onOpenFile,
}: {
  client: LoopClient | null;
  session: PairedSession | null;
  socketStatus: SocketStatus;
  localCards: NativeResultCard[];
  theme: LoopTheme;
  onToggleTheme: () => void;
  onOpenPairing: () => void;
  onSignOut: () => void;
  onOpenConversation: (input: {
    conversationId: string;
    title: string;
    agentName: string;
  }) => void;
  onOpenFile?: (file: PublishedFileItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const [section, setSection] = useState<ProfileSection>("saved");
  const [loading, setLoading] = useState(false);

  const [saved, setSaved] = useState<ApiSavedEntry[]>([]);
  const [reminders, setReminders] = useState<ApiLaterItem[]>([]);
  const [scheduled, setScheduled] = useState<ApiScheduledSend[]>([]);
  const [files, setFiles] = useState<PublishedFileItem[]>([]);
  const [filesNextCursor, setFilesNextCursor] = useState<number | null>(null);
  const [loadingMoreFiles, setLoadingMoreFiles] = useState(false);
  const [stories, setStories] = useState<ApiSocialStory[]>([]);
  const [profile, setProfile] = useState<ApiPersonalProfile | null>(null);

  const localCardsRef = useRef(localCards);
  localCardsRef.current = localCards;
  const loadGenRef = useRef(0);

  // Reset all profile state on workspace switch or sign-out and guard against stale responses
  useEffect(() => {
    loadGenRef.current += 1;
    setLoading(false);
    setProfile(null);
    setSaved([]);
    setReminders([]);
    setScheduled([]);
    setFiles([]);
    setFilesNextCursor(null);
    setLoadingMoreFiles(false);
    setStories([]);
    if (!client) return;
    let cancelled = false;
    void client
      .personalProfile()
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  const loadSection = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (!client) {
      setSaved(
        localCardsRef.current
          .filter((c) => c.saved)
          .map((c) => ({
            kind: "message",
            key: `m:${c.id}`,
            saved_at: c.createdAt,
            label: null,
            message: {
              message_id: c.id,
              conversation_id: c.conversationId,
              conversation_title: c.fallbackTitle,
              content: c.body,
              preview: c.body.slice(0, 140),
              agent_name: c.agentName,
              project_name: c.projectName,
              created_at: c.createdAt,
            },
          })),
      );
      setReminders([]);
      setScheduled([]);
      setFiles([]);
      setStories([]);
      return;
    }

    setLoading(true);
    try {
      if (section === "saved") {
        const data = await client.savedList();
        if (gen === loadGenRef.current) setSaved(data);
      } else if (section === "reminders") {
        const data = await client.laterList();
        if (gen === loadGenRef.current) setReminders(data);
      } else if (section === "scheduled") {
        const data = await client.scheduledList();
        if (gen === loadGenRef.current) setScheduled(data);
      } else if (section === "files") {
        const page = await client.personalFilesPage();
        if (gen === loadGenRef.current) {
          setFiles(page.items);
          setFilesNextCursor(page.next);
        }
      } else if (section === "social") {
        const data = await client.socialStories();
        if (gen === loadGenRef.current) setStories(data);
      }
    } catch {
      // keep existing items
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [client, section]);

  const loadMoreFiles = useCallback(async () => {
    if (!client || filesNextCursor === null || loadingMoreFiles || loading) {
      return;
    }
    const gen = loadGenRef.current;
    setLoadingMoreFiles(true);
    try {
      const page = await client.personalFilesPage({ before: filesNextCursor });
      if (gen !== loadGenRef.current) return;
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        const extra = page.items.filter((f) => !seen.has(f.id));
        return extra.length > 0 ? [...prev, ...extra] : prev;
      });
      setFilesNextCursor(page.next);
    } catch {
      // keep existing files
    } finally {
      if (gen === loadGenRef.current) setLoadingMoreFiles(false);
    }
  }, [client, filesNextCursor, loading, loadingMoreFiles]);

  useEffect(() => {
    void loadSection();
    return () => {
      loadGenRef.current += 1;
    };
  }, [loadSection]);

  // Keep demo Saved list synced when local demo cards change
  useEffect(() => {
    if (!client) {
      void loadSection();
    }
  }, [client, localCards, loadSection]);

  const statusColor =
    socketStatus === "live"
      ? theme.green
      : socketStatus === "connecting" || socketStatus === "reconnecting"
        ? theme.brass
        : theme.muted;

  const displayName =
    profile?.name?.trim() || session?.deviceName || "Your profile";
  const coverKey = profile?.handle || profile?.name || "atlas";

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: 0,
            paddingHorizontal: 0,
            borderBottomColor: theme.line,
          },
        ]}
      >
        {/* Coordinated Scenic Profile Cover Banner */}
        <View style={{ position: "relative" }}>
          <ProfileCoverBanner
            name={coverKey}
            height={92 + Math.max(insets.top, 20)}
          />
          <Pressable
            onPress={() => {
              haptics.selection();
              onToggleTheme();
            }}
            style={[
              styles.iconBtn,
              {
                position: "absolute",
                right: 16,
                top: Math.max(insets.top + 6, 16),
                backgroundColor: "rgba(20, 20, 18, 0.72)",
                borderColor: "rgba(255,255,255,0.14)",
              },
            ]}
          >
            {theme.isDark ? (
              <Sun size={16} color={theme.brassText} />
            ) : (
              <Moon size={16} color="#f5f5f2" />
            )}
          </Pressable>
        </View>

        <View style={styles.profileHeadBody}>
          <View style={styles.profileIdentityRow}>
            <View
              style={[
                styles.profileAvatarRing,
                { borderColor: theme.bg, backgroundColor: theme.bg },
              ]}
            >
              <AgentAvatar name={coverKey} size={56} />
            </View>
            <View style={{ flex: 1, paddingTop: 2 }}>
              <Text style={[styles.screenTitle, { color: theme.text }]}>
                {displayName}
              </Text>
              {profile?.handle ? (
                <Text style={[styles.profileHandle, { color: theme.muted }]}>
                  @{profile.handle.replace(/^@/, "")}
                </Text>
              ) : null}
            </View>
          </View>
          {profile?.bio ? (
            <Text style={[styles.profileBio, { color: theme.muted }]}>
              {profile.bio}
            </Text>
          ) : null}
          {profile && (
            <View style={styles.profileStatsRow}>
              {profile.prompt_count !== undefined && (
                <Text style={[styles.profileStat, { color: theme.muted }]}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>
                    {profile.prompt_count}
                  </Text>{" "}
                  prompts
                </Text>
              )}
              {profile.agent_count !== undefined && (
                <Text style={[styles.profileStat, { color: theme.muted }]}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>
                    {profile.agent_count}
                  </Text>{" "}
                  agents
                </Text>
              )}
              {profile.project_count !== undefined && (
                <Text style={[styles.profileStat, { color: theme.muted }]}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>
                    {profile.project_count}
                  </Text>{" "}
                  projects
                </Text>
              )}
            </View>
          )}

          {/* Workspace Connection Card */}
          <View
            style={[
              styles.workspaceCard,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <View style={styles.wsLeft}>
              <View style={styles.wsStatusRow}>
                <View
                  style={[styles.statusDot, { backgroundColor: statusColor }]}
                />
                <Text style={[styles.wsTitle, { color: theme.text }]}>
                  {session
                    ? session.origin.replace(/^https?:\/\//, "")
                    : "Offline Demo Deck"}
                </Text>
              </View>
              <Text style={[styles.wsSub, { color: theme.muted }]}>
                {session
                  ? `${session.deviceName} · ${socketStatus}`
                  : "Pair with `loop pair` to connect your live agents"}
              </Text>
            </View>

            <View style={styles.wsActions}>
              <Pressable
                onPress={() => {
                  haptics.light();
                  onOpenPairing();
                }}
                style={[
                  styles.wsBtn,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Link2 size={14} color={theme.brassText} />
                <Text style={[styles.wsBtnText, { color: theme.brassText }]}>
                  {session ? "Switch" : "Pair"}
                </Text>
              </Pressable>
              {session && (
                <Pressable
                  onPress={() => {
                    haptics.warning();
                    onSignOut();
                  }}
                  style={[
                    styles.wsIconBtn,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  <LogOut size={14} color={theme.orange} />
                </Pressable>
              )}
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.secRow}
          >
            {SECTIONS.map((sec) => {
              const active = sec.id === section;
              return (
                <Pressable
                  key={sec.id}
                  onPress={() => {
                    haptics.selection();
                    setSection(sec.id);
                  }}
                  style={[
                    styles.secChip,
                    {
                      backgroundColor: active ? theme.attention : theme.surface,
                      borderColor: active ? theme.attentionLine : theme.line,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.secLabel,
                      { color: active ? theme.brassText : theme.muted },
                    ]}
                  >
                    {sec.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>

      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void loadSection()}
            tintColor={theme.brassText}
          />
        }
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 96, 110) },
        ]}
      >
        {loading && (
          <ActivityIndicator
            color={theme.brassText}
            style={{ marginVertical: 12 }}
          />
        )}

        {section === "saved" &&
          (saved.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No saved cards yet. Swipe left on any Feed card or tap Save inside
              the carousel.
            </Text>
          ) : (
            saved.map((entry) => {
              const title =
                entry.message?.conversation_title ||
                entry.result?.title ||
                "Saved item";
              const convId =
                entry.message?.conversation_id || entry.result?.conversation_id;
              const agentName = entry.message?.agent_name || "agent";
              return (
                <Pressable
                  key={entry.key}
                  onPress={() => {
                    haptics.light();
                    if (convId) {
                      onOpenConversation({
                        conversationId: convId,
                        title,
                        agentName,
                      });
                    }
                  }}
                  style={[
                    styles.card,
                    { backgroundColor: theme.surface, borderColor: theme.line },
                  ]}
                >
                  <View style={styles.cardTop}>
                    <View style={styles.rowLeft}>
                      <BookmarkCheck size={14} color={theme.brassText} />
                      <Text
                        style={[styles.metaText, { color: theme.brassText }]}
                      >
                        @{agentName}
                      </Text>
                    </View>
                    <Text style={[styles.metaText, { color: theme.muted }]}>
                      {relativeTime(entry.saved_at)}
                    </Text>
                  </View>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>
                    {title}
                  </Text>
                  {entry.message?.preview ? (
                    <Text
                      style={[styles.cardSub, { color: theme.muted }]}
                      numberOfLines={2}
                    >
                      {entry.message.preview}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })
          ))}

        {section === "reminders" &&
          (reminders.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No active reminders.
            </Text>
          ) : (
            reminders.map((rem) => (
              <View
                key={rem.id}
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.rowLeft}>
                    <AlarmClock size={14} color={theme.brassText} />
                    <Text style={[styles.metaText, { color: theme.brassText }]}>
                      {rem.due_at
                        ? new Date(rem.due_at).toLocaleString()
                        : rem.condition}
                    </Text>
                  </View>
                  {client && (
                    <Pressable
                      onPress={async () => {
                        haptics.success();
                        await client.finishLater(rem.id);
                        setReminders((prev) =>
                          prev.filter((r) => r.id !== rem.id),
                        );
                      }}
                      hitSlop={8}
                    >
                      <Check size={16} color={theme.green} />
                    </Pressable>
                  )}
                </View>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {rem.title || "Reminder"}
                </Text>
              </View>
            ))
          ))}

        {section === "scheduled" &&
          (scheduled.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No scheduled messages.
            </Text>
          ) : (
            scheduled.map((s) => (
              <View
                key={s.id}
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.rowLeft}>
                    <CalendarClock size={14} color={theme.brassText} />
                    <Text style={[styles.metaText, { color: theme.brassText }]}>
                      {new Date(s.send_at).toLocaleString()}
                    </Text>
                  </View>
                  {client && (
                    <Pressable
                      onPress={async () => {
                        haptics.warning();
                        await client.cancelScheduled(s.id);
                        setScheduled((prev) =>
                          prev.filter((x) => x.id !== s.id),
                        );
                      }}
                    >
                      <Trash2 size={15} color={theme.orange} />
                    </Pressable>
                  )}
                </View>
                <Text
                  style={[styles.cardTitle, { color: theme.text }]}
                  numberOfLines={3}
                >
                  {s.input}
                </Text>
              </View>
            ))
          ))}

        {section === "files" &&
          (files.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No published agent files yet.
            </Text>
          ) : (
            <>
              {files.map((f) => {
                const sizeLabel = formatFileBytes(f.size);
                let thumbUri: string | null = null;
                if (client && isPreviewableImageMime(f.mime, f.name)) {
                  try {
                    thumbUri = client.sameOriginFileUrl(f.path, "preview=1");
                  } catch {
                    thumbUri = null;
                  }
                }
                return (
                  <Pressable
                    key={f.id}
                    accessibilityLabel={`Open file ${f.name}`}
                    onPress={() => {
                      haptics.light();
                      onOpenFile?.(f);
                    }}
                    style={({ pressed }) => [
                      styles.card,
                      {
                        backgroundColor: pressed ? theme.raised : theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    {thumbUri && client ? (
                      <Image
                        source={{
                          uri: thumbUri,
                          headers: client.fileRequestHeaders(),
                        }}
                        style={[
                          styles.fileThumb,
                          {
                            backgroundColor: theme.soft,
                            borderColor: theme.line,
                          },
                        ]}
                        resizeMode="cover"
                      />
                    ) : null}
                    <View style={styles.cardTop}>
                      <View style={styles.rowLeft}>
                        <FileText size={14} color={theme.brassText} />
                        <Text
                          style={[styles.metaText, { color: theme.brassText }]}
                        >
                          {f.agentName ? `@${f.agentName}` : "Published file"}
                        </Text>
                        <Text style={[styles.metaText, { color: theme.muted }]}>
                          {[
                            f.mime && f.mime !== "application/octet-stream"
                              ? f.mime
                              : null,
                            sizeLabel || null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      </View>
                      <View style={styles.rowLeft}>
                        {f.createdAt ? (
                          <Text
                            style={[styles.metaText, { color: theme.muted }]}
                          >
                            {relativeTime(f.createdAt)}
                          </Text>
                        ) : null}
                        <ArrowUpRight size={14} color={theme.brassText} />
                      </View>
                    </View>
                    <Text style={[styles.cardTitle, { color: theme.text }]}>
                      {f.name || f.title || "Published file"}
                    </Text>
                  </Pressable>
                );
              })}
              {filesNextCursor !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load more files"
                  disabled={loadingMoreFiles}
                  onPress={() => {
                    haptics.light();
                    void loadMoreFiles();
                  }}
                  style={({ pressed }) => [
                    styles.loadMoreBtn,
                    {
                      backgroundColor: pressed
                        ? theme.attention
                        : theme.surface,
                      borderColor: theme.line,
                      opacity: loadingMoreFiles ? 0.65 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.loadMoreText, { color: theme.text }]}>
                    {loadingMoreFiles
                      ? "Loading more files…"
                      : "Load more files"}
                  </Text>
                </Pressable>
              )}
            </>
          ))}

        {section === "social" &&
          (stories.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No RSS stories yet. Follow feeds in Loop to read them here.
            </Text>
          ) : (
            stories.map((st) => (
              <Pressable
                key={st.id}
                onPress={() => {
                  haptics.light();
                  if (client && !st.read) {
                    void client.socialMarkRead([st.id]).catch(() => {});
                  }
                  if (st.url) void Linking.openURL(st.url).catch(() => {});
                }}
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.rowLeft}>
                    <Rss size={13} color={theme.brassText} />
                    <Text style={[styles.metaText, { color: theme.brassText }]}>
                      {st.feed_title || "Feed"}
                    </Text>
                  </View>
                  {st.published_at ? (
                    <Text style={[styles.metaText, { color: theme.muted }]}>
                      {relativeTime(st.published_at)}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {st.title}
                </Text>
                {st.summary ? (
                  <Text
                    style={[styles.cardSub, { color: theme.muted }]}
                    numberOfLines={2}
                  >
                    {st.summary}
                  </Text>
                ) : null}
              </Pressable>
            ))
          ))}
      </ScrollView>
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
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  profileHeadBody: {
    paddingHorizontal: 16,
    gap: 10,
  },
  profileIdentityRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
    marginTop: -28,
  },
  profileAvatarRing: {
    borderRadius: 32,
    borderWidth: 3.5,
  },
  profileHandle: {
    fontSize: 13,
    fontWeight: "600",
  },
  profileBio: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  profileStatsRow: {
    flexDirection: "row",
    gap: 14,
  },
  profileStat: {
    fontSize: 12.5,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  wsLeft: {
    flex: 1,
    gap: 2,
  },
  wsStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  wsTitle: {
    fontSize: 14,
    fontWeight: "700",
    flexShrink: 1,
  },
  wsSub: {
    fontSize: 12,
  },
  wsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  wsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  wsBtnText: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  wsIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  secRow: {
    gap: 6,
  },
  secChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  secLabel: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  content: {
    padding: 16,
    gap: 10,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 12,
    fontWeight: "600",
  },
  cardTitle: {
    fontSize: 15.5,
    fontWeight: "700",
    lineHeight: 21,
  },
  cardSub: {
    fontSize: 13,
    lineHeight: 19,
  },
  fileThumb: {
    width: "100%",
    height: 150,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  emptyHint: {
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
    lineHeight: 20,
  },
  loadMoreBtn: {
    marginTop: 6,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadMoreText: {
    fontSize: 13.5,
    fontWeight: "600",
  },
});
