import React, { useMemo, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AlertTriangle, Check, ChevronRight, X } from "lucide-react-native";
import type { ApiNativeDecision } from "../api/types";
import { haptics } from "../haptics";
import {
  choiceLabel,
  choiceTone,
  questionAnswer,
  readNativeDecision,
} from "../native-decision";
import type { LoopTheme } from "../theme";
import { FeedTime } from "./FeedVisibility";

/**
 * A pending native decision (tool approval or harness question) in the
 * Needs you stack. Approvals answer `{ choice }`; questions answer one string
 * list per question id, as the server's validateAnswer expects.
 */
export function NativeDecisionCard({
  decision,
  theme,
  onAnswer,
  onOpenThread,
}: {
  decision: ApiNativeDecision;
  theme: LoopTheme;
  onAnswer: (id: string, answer: Record<string, unknown>) => void;
  onOpenThread: (conversationId: string, agentName: string) => void;
}) {
  const view = useMemo(() => readNativeDecision(decision), [decision]);
  const [expanded, setExpanded] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [sent, setSent] = useState(false);

  function send(answer: Record<string, unknown>) {
    if (sent) return;
    setSent(true);
    onAnswer(decision.id, answer);
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.attentionLine },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open @${view.agentName}'s conversation`}
        onPress={() => {
          haptics.light();
          onOpenThread(decision.conversation_id, view.agentName);
        }}
        style={styles.head}
      >
        <AlertTriangle size={14} color={theme.brassText} />
        <View style={styles.headText}>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
            {view.title}
          </Text>
          <Text style={[styles.meta, { color: theme.muted }]}>
            @{view.agentName} ·{" "}
            {view.kind === "approval" ? "Approval" : "Question"} ·{" "}
            <FeedTime timestamp={decision.created_at} />
          </Text>
        </View>
        <ChevronRight size={16} color={theme.muted} />
      </Pressable>

      {view.detail ? (
        <Pressable onPress={() => setExpanded((v) => !v)}>
          <Text
            selectable
            style={[
              styles.detail,
              { color: theme.text, backgroundColor: theme.soft },
            ]}
            numberOfLines={expanded ? undefined : 6}
          >
            {view.detail}
          </Text>
        </Pressable>
      ) : null}

      {view.completionUrl ? (
        <Pressable
          onPress={() => void Linking.openURL(view.completionUrl!)}
          hitSlop={6}
        >
          <Text style={[styles.link, { color: theme.blue }]}>
            Open completion page
          </Text>
        </Pressable>
      ) : null}

      {view.kind === "approval" ? (
        <View style={styles.choiceRow}>
          {view.choices.map((choice) => {
            const tone = choiceTone(choice);
            return (
              <Pressable
                key={choice}
                disabled={sent}
                accessibilityRole="button"
                onPress={() => {
                  if (tone === "allow") haptics.success();
                  else haptics.warning();
                  send({ choice });
                }}
                style={[
                  styles.choiceBtn,
                  tone === "allow"
                    ? { backgroundColor: theme.green }
                    : {
                        backgroundColor: theme.soft,
                        borderColor: theme.line,
                        borderWidth: 1,
                      },
                  sent && { opacity: 0.5 },
                ]}
              >
                {tone === "allow" ? (
                  <Check size={14} color={theme.onGreen} />
                ) : tone === "deny" ? (
                  <X size={14} color={theme.text} />
                ) : null}
                <Text
                  style={[
                    styles.choiceText,
                    { color: tone === "allow" ? theme.onGreen : theme.text },
                  ]}
                >
                  {choiceLabel(choice, view.completionUrl)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.form}>
          {view.questions.map((q) => (
            <View key={q.id} style={styles.question}>
              {q.title ? (
                <Text style={[styles.questionTitle, { color: theme.text }]}>
                  {q.title}
                </Text>
              ) : null}
              {q.options.length > 0 && (
                <View style={styles.options}>
                  {q.options.map((option) => {
                    const on = answers[q.id]?.includes(option) ?? false;
                    return (
                      <Pressable
                        key={option}
                        accessibilityRole={q.multiple ? "checkbox" : "radio"}
                        accessibilityState={{ checked: on }}
                        onPress={() => {
                          haptics.light();
                          setAnswers((old) => {
                            const prev = old[q.id] ?? [];
                            return {
                              ...old,
                              [q.id]: q.multiple
                                ? on
                                  ? prev.filter((v) => v !== option)
                                  : [...prev, option]
                                : [option],
                            };
                          });
                        }}
                        style={[
                          styles.option,
                          on
                            ? {
                                backgroundColor: theme.brass,
                                borderColor: theme.brass,
                              }
                            : {
                                backgroundColor: theme.attention,
                                borderColor: theme.attentionLine,
                              },
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionText,
                            { color: on ? theme.onBrass : theme.brassText },
                          ]}
                        >
                          {option}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              <TextInput
                accessibilityLabel={`${q.title || "Question"} response`}
                placeholder="Your response"
                placeholderTextColor={theme.muted}
                secureTextEntry={q.secret}
                autoCorrect={!q.secret}
                autoCapitalize={q.secret ? "none" : "sentences"}
                multiline={!q.secret}
                editable={!sent}
                onChangeText={(value) =>
                  setAnswers((old) => ({ ...old, [q.id]: [value] }))
                }
                style={[
                  styles.input,
                  {
                    color: theme.text,
                    backgroundColor: theme.bg,
                    borderColor: theme.line,
                  },
                ]}
              />
            </View>
          ))}
          <Pressable
            disabled={sent}
            accessibilityRole="button"
            onPress={() => {
              haptics.success();
              send(questionAnswer(view.questions, answers));
            }}
            style={[
              styles.sendBtn,
              { backgroundColor: theme.brass },
              sent && { opacity: 0.5 },
            ]}
          >
            <Text style={[styles.sendText, { color: theme.onBrass }]}>
              Send response
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headText: { flex: 1, gap: 2 },
  title: { fontSize: 14.5, fontWeight: "700" },
  meta: { fontSize: 12 },
  detail: {
    fontFamily: "Menlo",
    fontSize: 12.5,
    lineHeight: 18,
    borderRadius: 10,
    padding: 10,
    overflow: "hidden",
  },
  link: { fontSize: 13.5, fontWeight: "600" },
  choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choiceBtn: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
  },
  choiceText: { fontSize: 13.5, fontWeight: "700" },
  form: { gap: 12 },
  question: { gap: 7 },
  questionTitle: { fontSize: 13.5, fontWeight: "600" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  optionText: { fontSize: 13, fontWeight: "700" },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 12,
  },
  sendText: { fontSize: 14, fontWeight: "700" },
});
