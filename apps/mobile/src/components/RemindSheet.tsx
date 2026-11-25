import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AlarmClock, Clock, Sun, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

export type RemindChoice = {
  id: string;
  label: string;
  hint: string;
  condition: "time" | "run_finished";
  dueAt?: number;
};

function buildChoices(): RemindChoice[] {
  const now = new Date();
  const inOneHour = Date.now() + 60 * 60_000;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 3);
  nextWeek.setHours(9, 0, 0, 0);

  return [
    {
      id: "1h",
      label: "In 1 hour",
      hint: "Surface back in Later in 60 minutes",
      condition: "time",
      dueAt: inOneHour,
    },
    {
      id: "tomorrow",
      label: "Tomorrow morning",
      hint: "9:00 AM local time",
      condition: "time",
      dueAt: tomorrow.getTime(),
    },
    {
      id: "3d",
      label: "In 3 days",
      hint: "9:00 AM local time",
      condition: "time",
      dueAt: nextWeek.getTime(),
    },
    {
      id: "idle",
      label: "When agent finishes",
      hint: "Remind once active work completes",
      condition: "run_finished",
    },
  ];
}

export function RemindSheet({
  theme,
  title,
  onClose,
  onPick,
}: {
  theme: LoopTheme;
  title: string;
  onClose: () => void;
  onPick: (choice: RemindChoice) => void;
}) {
  const insets = useSafeAreaInsets();
  const choices = buildChoices();

  return (
    <Pressable
      style={[StyleSheet.absoluteFill, styles.overlay]}
      onPress={onClose}
    >
      <Pressable
        style={[
          styles.sheet,
          {
            backgroundColor: theme.surface,
            borderColor: theme.line,
            paddingBottom: Math.max(insets.bottom + 14, 22),
          },
        ]}
        onPress={() => {}}
      >
        <View style={styles.head}>
          <View style={styles.headLeft}>
            <AlarmClock size={18} color={theme.brassText} />
            <Text style={[styles.title, { color: theme.text }]}>Remind me</Text>
          </View>
          <Pressable
            onPress={() => {
              haptics.light();
              onClose();
            }}
          >
            <X size={18} color={theme.muted} />
          </Pressable>
        </View>
        <Text
          style={[styles.cardTitle, { color: theme.muted }]}
          numberOfLines={2}
        >
          {title}
        </Text>
        {choices.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => {
              haptics.success();
              onPick(c);
            }}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? theme.attention : theme.soft,
                borderColor: pressed ? theme.attentionLine : theme.line,
              },
            ]}
          >
            {c.id === "tomorrow" ? (
              <Sun size={16} color={theme.brassText} />
            ) : (
              <Clock size={16} color={theme.brassText} />
            )}
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: theme.text }]}>
                {c.label}
              </Text>
              <Text style={[styles.rowHint, { color: theme.muted }]}>
                {c.hint}
              </Text>
            </View>
          </Pressable>
        ))}
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: "rgba(0,0,0,0.48)",
    justifyContent: "flex-end",
    zIndex: 55,
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 16,
    gap: 10,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 16.5,
    fontWeight: "700",
  },
  cardTitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  rowHint: {
    fontSize: 12,
  },
});
