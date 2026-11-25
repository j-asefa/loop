import React, { useCallback, useEffect, useState } from "react";
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  GitPullRequest,
  XCircle,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LoopClient } from "../api/client";
import type { ApiPullItem } from "../api/types";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

const DEMO_PULLS: ApiPullItem[] = [
  {
    owner: "j-asefa",
    repo: "loop",
    number: 449,
    title: "Open Done results in their reading sheet again",
    state: "open",
    author: "cedar",
    checks_state: "success",
    review_decision: "APPROVED",
    url: "https://github.com/j-asefa/loop/pull/449",
  },
  {
    owner: "j-asefa",
    repo: "loop",
    number: 444,
    title: "Keep Antigravity MCP tools within the eager schema budget",
    state: "merged",
    author: "willow",
    checks_state: "success",
    review_decision: "APPROVED",
    url: "https://github.com/j-asefa/loop/pull/444",
  },
];

export function PullRequestsScreen({
  client,
  theme,
  onOpenConversation,
}: {
  client: LoopClient | null;
  theme: LoopTheme;
  onOpenConversation: (input: {
    conversationId: string;
    title: string;
    agentName: string;
  }) => void;
}) {
  const insets = useSafeAreaInsets();
  const [pulls, setPulls] = useState<ApiPullItem[]>(client ? [] : DEMO_PULLS);
  const [loading, setLoading] = useState(Boolean(client));
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!client) {
      setPulls(DEMO_PULLS);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const list = await client.githubPulls();
      setPulls(list);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Connect GitHub in Loop Settings to inspect pull requests.",
      );
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

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
          Pull requests
        </Text>
      </View>

      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void load()}
            tintColor={theme.brass}
          />
        }
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom + 96, 110) },
        ]}
      >
        {error ? (
          <View
            style={[
              styles.noticeCard,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <Text style={[styles.noticeText, { color: theme.muted }]}>
              {error}
            </Text>
          </View>
        ) : null}

        {pulls.map((pr) => {
          const checksOk = pr.checks_state === "success";
          const checksFail =
            pr.checks_state === "failure" || pr.checks_state === "error";
          return (
            <Pressable
              key={`${pr.owner}/${pr.repo}#${pr.number}`}
              onPress={() => {
                haptics.light();
                if (pr.conversation_id) {
                  onOpenConversation({
                    conversationId: pr.conversation_id,
                    title: pr.title,
                    agentName: pr.author || "github",
                  });
                } else if (pr.url) {
                  void Linking.openURL(pr.url).catch(() => {});
                }
              }}
              style={({ pressed }) => [
                styles.card,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.line,
                  transform: [{ scale: pressed ? 0.985 : 1 }],
                },
              ]}
            >
              <View style={styles.cardTop}>
                <View style={styles.repoRow}>
                  <GitPullRequest size={15} color={theme.brassText} />
                  <Text style={[styles.repoText, { color: theme.muted }]}>
                    {pr.owner}/{pr.repo} #{pr.number}
                  </Text>
                </View>
                {pr.url && (
                  <Pressable
                    hitSlop={8}
                    onPress={() => {
                      haptics.light();
                      void Linking.openURL(pr.url!).catch(() => {});
                    }}
                  >
                    <ExternalLink size={14} color={theme.muted} />
                  </Pressable>
                )}
              </View>

              <Text style={[styles.prTitle, { color: theme.text }]}>
                {pr.title}
              </Text>

              <View style={styles.badgeRow}>
                {checksOk && (
                  <View
                    style={[styles.badge, { backgroundColor: theme.greenSoft }]}
                  >
                    <CheckCircle2 size={12} color={theme.green} />
                    <Text style={[styles.badgeText, { color: theme.green }]}>
                      Checks passing
                    </Text>
                  </View>
                )}
                {checksFail && (
                  <View
                    style={[
                      styles.badge,
                      { backgroundColor: theme.orangeSoft },
                    ]}
                  >
                    <XCircle size={12} color={theme.orange} />
                    <Text style={[styles.badgeText, { color: theme.orange }]}>
                      Checks failing
                    </Text>
                  </View>
                )}
                {!checksOk && !checksFail && pr.checks_state && (
                  <View style={[styles.badge, { backgroundColor: theme.soft }]}>
                    <Clock size={12} color={theme.muted} />
                    <Text style={[styles.badgeText, { color: theme.muted }]}>
                      {pr.checks_state}
                    </Text>
                  </View>
                )}
                {pr.review_decision && (
                  <View
                    style={[
                      styles.badge,
                      {
                        backgroundColor: theme.attention,
                        borderColor: theme.attentionLine,
                        borderWidth: StyleSheet.hairlineWidth,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.badgeText, { color: theme.brassText }]}
                    >
                      {pr.review_decision.replace(/_/g, " ")}
                    </Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}

        {!loading && !error && pulls.length === 0 && (
          <View
            style={[
              styles.noticeCard,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <Text style={[styles.noticeText, { color: theme.muted }]}>
              No open pull requests right now.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  content: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 15,
    gap: 9,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  repoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  repoText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
  prTitle: {
    fontSize: 16.5,
    fontWeight: "700",
    lineHeight: 22,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11.5,
    fontWeight: "700",
  },
  noticeCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    alignItems: "center",
  },
  noticeText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
