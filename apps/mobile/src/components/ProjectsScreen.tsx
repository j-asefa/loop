import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  Layers,
  Plus,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import type { ApiAgent, ApiFolder, ApiProjectSummary } from "../api/types";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { AgentAvatar } from "./RichContent";

export function ProjectsScreen({
  client,
  folders,
  agents,
  localCards,
  theme,
  onOpenConversation,
  onOpenAgent,
  onNewTaskInProject,
}: {
  client: LoopClient | null;
  folders: ApiFolder[];
  agents: ApiAgent[];
  localCards: NativeResultCard[];
  theme: LoopTheme;
  onOpenConversation: (input: {
    conversationId: string;
    title: string;
    agentName: string;
    agentId?: string | null;
  }) => void;
  onOpenAgent: (agent: ApiAgent) => void;
  onNewTaskInProject: (folderId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [summaries, setSummaries] = useState<ApiProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [projectThreads, setProjectThreads] = useState<
    Array<{
      conversationId: string;
      title: string;
      agentName: string;
      agentId?: string | null;
      updatedAt: number;
      preview: string;
    }>
  >([]);
  const [loading, setLoading] = useState(false);

  const loadSummaries = useCallback(async () => {
    if (!client) {
      // Derive from local demo cards
      const map = new Map<string, ApiProjectSummary>();
      for (const c of localCards) {
        const cur = map.get(c.projectName) ?? {
          id: c.projectName,
          name: c.projectName,
          conversation_count: 0,
          unread_count: 0,
          last_activity_at: 0,
        };
        cur.conversation_count = (cur.conversation_count ?? 0) + 1;
        if (c.unread) cur.unread_count = (cur.unread_count ?? 0) + 1;
        cur.last_activity_at = Math.max(cur.last_activity_at ?? 0, c.createdAt);
        map.set(c.projectName, cur);
      }
      setSummaries([...map.values()]);
      return;
    }
    setLoading(true);
    try {
      const list = await client.projectSummaries();
      if (list.length) {
        setSummaries(list);
      } else {
        setSummaries(
          folders
            .filter((f) => f.kind === "project" || f.is_workspace)
            .map((f) => ({ id: f.id, name: f.name })),
        );
      }
    } catch {
      setSummaries(
        folders
          .filter((f) => f.kind === "project" || f.is_workspace)
          .map((f) => ({ id: f.id, name: f.name })),
      );
    } finally {
      setLoading(false);
    }
  }, [client, folders, localCards]);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  const openProject = useCallback(
    async (proj: { id: string; name: string }) => {
      haptics.light();
      setSelectedProject(proj);
      if (!client) {
        setProjectThreads(
          localCards
            .filter((c) => c.projectName === proj.name)
            .map((c) => ({
              conversationId: c.conversationId,
              title: c.fallbackTitle,
              agentName: c.agentName,
              updatedAt: c.createdAt,
              preview: c.body.slice(0, 120),
            })),
        );
        return;
      }
      setLoading(true);
      try {
        const page = await client.feed("done", { folder: proj.id });
        setProjectThreads(
          page.items.map((item) => ({
            conversationId: item.conversation_id,
            title: item.title,
            agentName: item.agent_name || "agent",
            agentId: item.agent_id,
            updatedAt: item.last_activity_at,
            preview:
              item.last_message?.preview ||
              item.last_message?.content?.slice(0, 140) ||
              "",
          })),
        );
      } catch {
        setProjectThreads([]);
      } finally {
        setLoading(false);
      }
    },
    [client, localCards],
  );

  const projectAgents = useMemo(() => {
    if (!selectedProject) return [];
    return agents.filter(
      (a) => !a.retired_at && a.folder_id === selectedProject.id,
    );
  }, [agents, selectedProject]);

  if (selectedProject) {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg }]}>
        <View
          style={[
            styles.header,
            {
              paddingTop: Math.max(insets.top + 8, 18),
              borderBottomColor: theme.line,
            },
          ]}
        >
          <Pressable
            onPress={() => {
              haptics.light();
              setSelectedProject(null);
            }}
            style={[
              styles.iconBtn,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <ArrowLeft size={17} color={theme.text} />
          </Pressable>
          <Text
            style={[styles.headerTitle, { color: theme.text }]}
            numberOfLines={1}
          >
            {selectedProject.name}
          </Text>
          <Pressable
            onPress={() => {
              haptics.light();
              onNewTaskInProject(selectedProject.id);
            }}
            style={[
              styles.iconBtn,
              {
                backgroundColor: theme.attention,
                borderColor: theme.attentionLine,
              },
            ]}
          >
            <Plus size={17} color={theme.brassText} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(insets.bottom + 96, 110) },
          ]}
        >
          {projectAgents.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: theme.muted }]}>
                AGENTS
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {projectAgents.map((a) => (
                  <Pressable
                    key={a.id}
                    onPress={() => {
                      haptics.light();
                      onOpenAgent(a);
                    }}
                    style={[
                      styles.agentChip,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <AgentAvatar name={a.name} size={22} />
                    <Text style={[styles.agentChipName, { color: theme.text }]}>
                      @{a.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          <Text style={[styles.sectionLabel, { color: theme.muted }]}>
            RECENT RESULTS
          </Text>
          {loading ? (
            <ActivityIndicator color={theme.brass} style={{ marginTop: 24 }} />
          ) : projectThreads.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No results in this project yet.
            </Text>
          ) : (
            projectThreads.map((t, idx) => (
              <Pressable
                key={`${t.conversationId}-${idx}`}
                onPress={() => {
                  haptics.light();
                  onOpenConversation(t);
                }}
                style={({ pressed }) => [
                  styles.card,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.line,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.rowLeft}>
                    <AgentAvatar name={t.agentName} size={22} />
                    <Text style={[styles.agentText, { color: theme.text }]}>
                      @{t.agentName}
                    </Text>
                  </View>
                  <Text style={[styles.timeText, { color: theme.muted }]}>
                    {relativeTime(t.updatedAt)}
                  </Text>
                </View>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {t.title}
                </Text>
                {t.preview ? (
                  <Text
                    style={[styles.cardSub, { color: theme.muted }]}
                    numberOfLines={2}
                  >
                    {t.preview}
                  </Text>
                ) : null}
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: Math.max(insets.top + 8, 18),
            borderBottomColor: theme.line,
          },
        ]}
      >
        <Text style={[styles.screenTitle, { color: theme.text }]}>
          Projects
        </Text>
      </View>

      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void loadSummaries()}
            tintColor={theme.brass}
          />
        }
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 96, 110) },
        ]}
      >
        {summaries.map((proj) => (
          <Pressable
            key={proj.id}
            onPress={() => void openProject({ id: proj.id, name: proj.name })}
            style={({ pressed }) => [
              styles.projCard,
              {
                backgroundColor: theme.surface,
                borderColor: theme.line,
                transform: [{ scale: pressed ? 0.985 : 1 }],
              },
            ]}
          >
            <View
              style={[
                styles.projIcon,
                {
                  backgroundColor: theme.attention,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <Folder size={18} color={theme.brassText} />
            </View>
            <View style={styles.projInfo}>
              <Text style={[styles.projName, { color: theme.text }]}>
                {proj.name}
              </Text>
              <View style={styles.projMetaRow}>
                {proj.conversation_count !== undefined && (
                  <View style={styles.metaPill}>
                    <Layers size={11} color={theme.muted} />
                    <Text style={[styles.metaText, { color: theme.muted }]}>
                      {proj.conversation_count} threads
                    </Text>
                  </View>
                )}
                {!!proj.unread_count && (
                  <Text style={[styles.unreadText, { color: theme.brassText }]}>
                    · {proj.unread_count} unread
                  </Text>
                )}
              </View>
            </View>
            <ChevronRight size={17} color={theme.muted} />
          </Pressable>
        ))}

        {!loading && summaries.length === 0 && (
          <Text style={[styles.emptyHint, { color: theme.muted }]}>
            No projects yet. Pair your Loop workspace to browse your projects
            and folders.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    padding: 16,
    gap: 12,
  },
  section: {
    gap: 8,
    marginBottom: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  agentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  agentChipName: {
    fontSize: 13,
    fontWeight: "600",
  },
  projCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
  },
  projIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  projInfo: {
    flex: 1,
    gap: 3,
  },
  projName: {
    fontSize: 16,
    fontWeight: "700",
  },
  projMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontSize: 12.5,
  },
  unreadText: {
    fontSize: 12.5,
    fontWeight: "700",
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
    gap: 7,
  },
  agentText: {
    fontSize: 13,
    fontWeight: "700",
  },
  timeText: {
    fontSize: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 21,
  },
  cardSub: {
    fontSize: 13.5,
    lineHeight: 19,
  },
  emptyHint: {
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
    lineHeight: 20,
  },
});
