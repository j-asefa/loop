import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { MessageSquare, Search, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { searchThreadCards } from "../../../../src/shared/done-stack";
import type { LoopClient } from "../api/client";
import type { ApiAgent, ApiPersonalPrompt, ApiSearchItem } from "../api/types";
import { relativeTime, type NativeResultCard } from "../fixtures";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";
import { AgentAvatar } from "./RichContent";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "replies", label: "Replies" },
  { id: "prompts", label: "Your prompts" },
] as const;

export function SearchScreen({
  client,
  agents,
  localCards,
  theme,
  onOpenConversation,
  onOpenAgent,
}: {
  client: LoopClient | null;
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
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [results, setResults] = useState<ApiSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [prompts, setPrompts] = useState<ApiPersonalPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const searchSeqRef = useRef(0);

  const matchingAgents = useMemo(() => {
    const clean = query.trim().replace(/^@/, "").toLowerCase();
    if (!clean) return [];
    return agents
      .filter((a) => !a.retired_at && a.name.toLowerCase().includes(clean))
      .slice(0, 4);
  }, [agents, query]);

  const runSearch = useCallback(async () => {
    const seq = ++searchSeqRef.current;
    const q = query.trim();
    setNextCursor(null);
    setLoadingMore(false);
    if (category === "prompts") {
      if (!client) {
        setPrompts(
          localCards
            .filter(
              (c) => !q || c.prompt.toLowerCase().includes(q.toLowerCase()),
            )
            .map((c) => ({
              id: c.id,
              conversation_id: c.conversationId,
              conversation_title: c.fallbackTitle,
              agent_name: c.agentName,
              project_name: c.projectName,
              content: c.prompt,
              created_at: c.createdAt,
            })),
        );
        return;
      }
      setLoading(true);
      try {
        const list = await client.personalPrompts(q || undefined);
        if (seq === searchSeqRef.current) setPrompts(list);
      } catch {
        if (seq === searchSeqRef.current) setPrompts([]);
      } finally {
        if (seq === searchSeqRef.current) setLoading(false);
      }
      return;
    }

    if (!q) {
      setResults([]);
      return;
    }

    if (!client) {
      const hits = searchThreadCards(
        localCards.map((c) => ({
          id: c.id,
          title: c.fallbackTitle,
          prompt: c.prompt,
          body: c.body,
          createdAt: c.createdAt,
          saved: c.saved,
          unread: c.unread,
        })),
        q,
      );
      setResults(
        hits.map((h) => {
          const card = localCards[h.index];
          return {
            id: h.cardId,
            kind: "message",
            title: h.title,
            agent_id: null,
            conversation_id: card.conversationId,
            folder_id: null,
            created_at: h.createdAt,
            updated_at: h.createdAt,
            name: card.agentName,
            snippet: h.snippet.map((s) => s.text).join(""),
            message_id: card.id,
          };
        }),
      );
      return;
    }

    setLoading(true);
    try {
      const res = await client.search(q, category);
      if (seq === searchSeqRef.current) {
        setResults(res.items);
        setNextCursor(res.next ?? null);
      }
    } catch {
      if (seq === searchSeqRef.current) {
        setResults([]);
        setNextCursor(null);
      }
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }, [client, query, category, localCards]);

  const loadMoreResults = useCallback(async () => {
    const q = query.trim();
    if (!client || !q || nextCursor === null || loadingMore || loading) return;
    const seq = searchSeqRef.current;
    setLoadingMore(true);
    try {
      const res = await client.search(q, category, nextCursor);
      if (seq !== searchSeqRef.current) return;
      setResults((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const extra = res.items.filter((item) => !seen.has(item.id));
        return extra.length > 0 ? [...prev, ...extra] : prev;
      });
      setNextCursor(res.next ?? null);
    } catch {
      // keep existing results
    } finally {
      if (seq === searchSeqRef.current) setLoadingMore(false);
    }
  }, [category, client, loading, loadingMore, nextCursor, query]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch();
    }, 220);
    return () => clearTimeout(timer);
  }, [runSearch]);

  function snippetText(snippet: ApiSearchItem["snippet"]): string {
    if (!snippet) return "";
    if (typeof snippet === "string") return snippet;
    if (snippet.text) return snippet.text;
    if (Array.isArray(snippet.segments)) {
      return snippet.segments.map((s) => s.text).join("");
    }
    return "";
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
        <Text style={[styles.screenTitle, { color: theme.text }]}>Search</Text>

        <View
          style={[
            styles.searchField,
            { backgroundColor: theme.surface, borderColor: theme.line },
          ]}
        >
          <Search size={16} color={theme.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search results, threads, @agents…"
            placeholderTextColor={theme.muted}
            style={[styles.searchInput, { color: theme.text }]}
            returnKeyType="search"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => {
                haptics.light();
                setQuery("");
              }}
              hitSlop={8}
            >
              <X size={16} color={theme.muted} />
            </Pressable>
          )}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.catRow}
        >
          {CATEGORIES.map((cat) => {
            const active = cat.id === category;
            return (
              <Pressable
                key={cat.id}
                onPress={() => {
                  haptics.selection();
                  setCategory(cat.id);
                }}
                style={[
                  styles.catChip,
                  {
                    backgroundColor: active ? theme.attention : theme.surface,
                    borderColor: active ? theme.attentionLine : theme.line,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.catLabel,
                    { color: active ? theme.brassText : theme.muted },
                  ]}
                >
                  {cat.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 96, 110) },
        ]}
      >
        {matchingAgents.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: theme.muted }]}>
              AGENTS
            </Text>
            <View style={styles.agentRow}>
              {matchingAgents.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    haptics.light();
                    onOpenAgent(a);
                  }}
                  style={[
                    styles.agentPill,
                    { backgroundColor: theme.surface, borderColor: theme.line },
                  ]}
                >
                  <AgentAvatar name={a.name} size={22} />
                  <Text style={[styles.agentPillText, { color: theme.text }]}>
                    @{a.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {loading ? (
          <ActivityIndicator
            color={theme.brassText}
            style={{ marginTop: 28 }}
          />
        ) : category === "prompts" ? (
          prompts.length === 0 ? (
            <Text style={[styles.emptyHint, { color: theme.muted }]}>
              No prompts found.
            </Text>
          ) : (
            prompts.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => {
                  haptics.light();
                  onOpenConversation({
                    conversationId: p.conversation_id,
                    title: p.conversation_title || p.content.slice(0, 80),
                    agentName: p.agent_name || "agent",
                  });
                }}
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.cardTop}>
                  <View style={styles.rowLeft}>
                    <MessageSquare size={13} color={theme.brassText} />
                    <Text style={[styles.metaText, { color: theme.brassText }]}>
                      @{p.agent_name || "agent"}
                    </Text>
                  </View>
                  <Text style={[styles.metaText, { color: theme.muted }]}>
                    {relativeTime(p.created_at)}
                  </Text>
                </View>
                <Text
                  style={[styles.cardTitle, { color: theme.text }]}
                  numberOfLines={3}
                >
                  {p.content}
                </Text>
              </Pressable>
            ))
          )
        ) : !query.trim() ? (
          <Text style={[styles.emptyHint, { color: theme.muted }]}>
            Type a keyword to search across all your Loop results and threads,
            or switch to “Your prompts” to browse what you asked.
          </Text>
        ) : results.length === 0 ? (
          <Text style={[styles.emptyHint, { color: theme.muted }]}>
            No matches for “{query.trim()}”.
          </Text>
        ) : (
          <>
            {results.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => {
                  haptics.light();
                  if (item.conversation_id) {
                    onOpenConversation({
                      conversationId: item.conversation_id,
                      title: item.title,
                      agentName: item.name || "agent",
                      agentId: item.agent_id,
                    });
                  }
                }}
                style={[
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: theme.line },
                ]}
              >
                <View style={styles.cardTop}>
                  <Text style={[styles.metaText, { color: theme.brassText }]}>
                    {item.name ? `@${item.name}` : item.kind}
                  </Text>
                  <Text style={[styles.metaText, { color: theme.muted }]}>
                    {relativeTime(item.updated_at || item.created_at)}
                  </Text>
                </View>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {item.title}
                </Text>
                {snippetText(item.snippet) ? (
                  <Text
                    style={[styles.snippet, { color: theme.muted }]}
                    numberOfLines={3}
                  >
                    {snippetText(item.snippet)}
                  </Text>
                ) : null}
              </Pressable>
            ))}
            {nextCursor !== null && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load more results"
                disabled={loadingMore}
                onPress={() => {
                  haptics.light();
                  void loadMoreResults();
                }}
                style={({ pressed }) => [
                  styles.loadMoreBtn,
                  {
                    backgroundColor: pressed ? theme.attention : theme.surface,
                    borderColor: theme.line,
                    opacity: loadingMore ? 0.65 : 1,
                  },
                ]}
              >
                <Text style={[styles.loadMoreText, { color: theme.text }]}>
                  {loadingMore ? "Loading more results…" : "Load more results"}
                </Text>
              </Pressable>
            )}
          </>
        )}
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
    gap: 10,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
  },
  catRow: {
    gap: 6,
  },
  catChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  catLabel: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  content: {
    padding: 16,
    gap: 10,
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
  agentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  agentPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  agentPillText: {
    fontSize: 13,
    fontWeight: "600",
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 5,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
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
  snippet: {
    fontSize: 13,
    lineHeight: 19,
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
