import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CalendarClock, Clock, RotateCcw, Sun, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "../haptics";
import {
  buildSchedulePresets,
  computeCustomSendAt,
  formatScheduledTime,
  validateSendAt,
} from "../schedule-utils";
import type { LoopTheme } from "../theme";

const CUSTOM_OFFSETS: Array<{ label: string; minutes: number }> = [
  { label: "+2h", minutes: 120 },
  { label: "+4h", minutes: 240 },
  { label: "+8h", minutes: 480 },
  { label: "+2d", minutes: 2 * 24 * 60 },
  { label: "+7d", minutes: 7 * 24 * 60 },
];

export function ScheduleSendSheet({
  visible,
  theme,
  agentName,
  previewText,
  attachmentCount = 0,
  busy = false,
  error = "",
  lockedSendAt = null,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  theme: LoopTheme;
  agentName: string;
  previewText: string;
  attachmentCount?: number;
  busy?: boolean;
  error?: string;
  /** When a prior schedule attempt timed out (uncertain outcome), lock to that
   * exact timestamp so retrying reuses the same idempotencyKey without 409. */
  lockedSendAt?: number | null;
  onClose: () => void;
  onConfirm: (sendAt: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const [customMinutes, setCustomMinutes] = useState<number | null>(null);
  const [localError, setLocalError] = useState("");

  // Recompute presets each time the sheet opens.
  const presets = useMemo(
    () => (visible ? buildSchedulePresets() : []),
    [visible],
  );

  if (!visible) return null;

  const displayedError = error || localError;
  const lockedLabel =
    lockedSendAt !== null ? formatScheduledTime(lockedSendAt) : "";

  function handlePickTimestamp(sendAt: number) {
    if (busy) return;
    if (lockedSendAt !== null) {
      setLocalError("");
      haptics.medium();
      onConfirm(lockedSendAt);
      return;
    }
    const check = validateSendAt(sendAt);
    if (!check.ok) {
      haptics.warning();
      setLocalError(check.error);
      return;
    }
    setLocalError("");
    haptics.medium();
    onConfirm(sendAt);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <Pressable
        style={styles.overlay}
        onPress={() => {
          if (!busy) onClose();
        }}
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
              <CalendarClock size={18} color={theme.brassText} />
              <Text style={[styles.title, { color: theme.text }]}>
                Schedule for @{agentName}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close schedule picker"
              disabled={busy}
              onPress={() => {
                haptics.light();
                onClose();
              }}
              hitSlop={8}
            >
              <X size={18} color={theme.muted} />
            </Pressable>
          </View>

          <View
            style={[
              styles.previewBox,
              { backgroundColor: theme.soft, borderColor: theme.line },
            ]}
          >
            <Text
              style={[styles.previewText, { color: theme.text }]}
              numberOfLines={2}
            >
              {previewText.trim() ||
                `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}`}
            </Text>
            {attachmentCount > 0 && previewText.trim() ? (
              <Text style={[styles.previewMeta, { color: theme.muted }]}>
                + {attachmentCount}{" "}
                {attachmentCount === 1 ? "attachment" : "attachments"}
              </Text>
            ) : null}
          </View>

          {lockedSendAt !== null ? (
            <View
              style={[
                styles.lockedBox,
                {
                  backgroundColor: theme.attention,
                  borderColor: theme.attentionLine,
                },
              ]}
            >
              <Text style={[styles.lockedTitle, { color: theme.brassText }]}>
                Pending confirmation · {lockedLabel}
              </Text>
              <Text style={[styles.lockedHint, { color: theme.muted }]}>
                The previous request did not finish cleanly. Retry with the same
                time to confirm without scheduling a duplicate, or check Profile
                → Scheduled first.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry scheduled send"
                disabled={busy}
                onPress={() => handlePickTimestamp(lockedSendAt)}
                style={[
                  styles.retryBtn,
                  {
                    backgroundColor: theme.brass,
                    opacity: busy ? 0.6 : 1,
                  },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={theme.onBrass} />
                ) : (
                  <>
                    <RotateCcw size={14} color={theme.onBrass} />
                    <Text
                      style={[styles.retryBtnText, { color: theme.onBrass }]}
                    >
                      Retry schedule
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : (
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
            >
              {presets.map((preset) => (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Schedule ${preset.label}`}
                  disabled={busy}
                  onPress={() => handlePickTimestamp(preset.sendAt)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: pressed ? theme.attention : theme.soft,
                      borderColor: pressed ? theme.attentionLine : theme.line,
                      opacity: busy ? 0.6 : 1,
                    },
                  ]}
                >
                  {preset.id === "tomorrow" ? (
                    <Sun size={16} color={theme.brassText} />
                  ) : (
                    <Clock size={16} color={theme.brassText} />
                  )}
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: theme.text }]}>
                      {preset.label}
                    </Text>
                    <Text style={[styles.rowHint, { color: theme.muted }]}>
                      {preset.hint}
                    </Text>
                  </View>
                </Pressable>
              ))}

              <Text style={[styles.customLabel, { color: theme.muted }]}>
                Or pick a custom delay
              </Text>
              <View style={styles.customRow}>
                {CUSTOM_OFFSETS.map((opt) => {
                  const selected = customMinutes === opt.minutes;
                  return (
                    <Pressable
                      key={opt.label}
                      disabled={busy}
                      onPress={() => {
                        haptics.selection();
                        setCustomMinutes(opt.minutes);
                        setLocalError("");
                      }}
                      style={[
                        styles.customChip,
                        {
                          backgroundColor: selected
                            ? theme.attention
                            : theme.soft,
                          borderColor: selected
                            ? theme.attentionLine
                            : theme.line,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.customChipText,
                          {
                            color: selected ? theme.brassText : theme.text,
                          },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {customMinutes !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm custom schedule"
                  disabled={busy}
                  onPress={() =>
                    handlePickTimestamp(computeCustomSendAt(customMinutes))
                  }
                  style={[
                    styles.confirmBtn,
                    {
                      backgroundColor: theme.brass,
                      opacity: busy ? 0.6 : 1,
                    },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.onBrass} />
                  ) : (
                    <Text
                      style={[styles.confirmBtnText, { color: theme.onBrass }]}
                    >
                      Schedule for{" "}
                      {formatScheduledTime(computeCustomSendAt(customMinutes))}
                    </Text>
                  )}
                </Pressable>
              )}
            </ScrollView>
          )}

          {busy && lockedSendAt === null && customMinutes === null && (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={theme.brassText} />
              <Text style={[styles.busyText, { color: theme.muted }]}>
                Scheduling message…
              </Text>
            </View>
          )}

          {displayedError ? (
            <Text style={[styles.errorText, { color: theme.orange }]}>
              {displayedError}
            </Text>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.48)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 16,
    gap: 10,
    maxHeight: "82%",
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
    flex: 1,
    marginRight: 10,
  },
  title: {
    fontSize: 16.5,
    fontWeight: "700",
  },
  previewBox: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 3,
  },
  previewText: {
    fontSize: 13.5,
    lineHeight: 18,
  },
  previewMeta: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  list: {
    maxHeight: 360,
  },
  listContent: {
    gap: 8,
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
  customLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  customRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  customChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
  },
  customChipText: {
    fontSize: 13,
    fontWeight: "700",
  },
  confirmBtn: {
    marginTop: 4,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  confirmBtnText: {
    fontSize: 14,
    fontWeight: "700",
  },
  lockedBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  lockedTitle: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  lockedHint: {
    fontSize: 12.5,
    lineHeight: 17,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 40,
    borderRadius: 12,
  },
  retryBtnText: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  busyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 4,
  },
  busyText: {
    fontSize: 13,
    fontWeight: "600",
  },
  errorText: {
    fontSize: 12.5,
    lineHeight: 17,
  },
});
