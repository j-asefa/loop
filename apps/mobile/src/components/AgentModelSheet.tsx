import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApiConnection } from "../api/types";
import {
  connectedHarnesses,
  defaultModelFor,
  effortLabel,
  harnessLabel,
  modelCatalog,
  modelIdLabel,
  type AgentModelSelection,
} from "../models";
import type { LoopTheme } from "../theme";

export function AgentModelSheet({
  initialSelection,
  caption,
  confirmLabel = "Save model and effort",
  connections,
  theme,
  onClose,
  onSave,
}: {
  initialSelection: AgentModelSelection;
  caption?: string;
  confirmLabel?: string;
  connections: ApiConnection[];
  theme: LoopTheme;
  onClose: () => void;
  onSave: (selection: AgentModelSelection) => Promise<void> | void;
}) {
  const insets = useSafeAreaInsets();
  const harnesses = useMemo(
    () => connectedHarnesses(connections),
    [connections],
  );
  const [selection, setSelection] = useState(initialSelection);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const connection = harnesses.find(
    (item) => item.id === selection.connectionId,
  );
  const models = useMemo(() => modelCatalog(connection), [connection]);
  const selected = models.find((model) => model.id === selection.model);
  const queryText = query.trim().toLowerCase();
  const matches = models.filter(
    (model) =>
      !queryText ||
      `${model.name} ${model.id} ${model.resolvedModel ?? ""}`
        .toLowerCase()
        .includes(queryText),
  );
  const canSave = Boolean(
    selected &&
    (!selection.effort || selected.effortLevels?.includes(selection.effort)),
  );
  const close = () => {
    if (!savingRef.current) onClose();
  };

  async function save() {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(selection);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update the agent.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function choice(
    label: string,
    active: boolean,
    onPress: () => void,
    key: string,
  ) {
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: saving }}
        disabled={saving}
        onPress={() => {
          setError("");
          onPress();
        }}
        style={[
          styles.choice,
          {
            backgroundColor: active ? theme.attention : theme.soft,
            borderColor: active ? theme.attentionLine : theme.line,
          },
        ]}
      >
        <Text style={{ color: active ? theme.brassText : theme.text }}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <Modal animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[
          styles.screen,
          {
            backgroundColor: theme.surface,
            paddingTop: Math.max(insets.top, 16),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.heading}>
            <Text style={[styles.title, { color: theme.text }]}>
              Model and effort
            </Text>
            {caption && <Text style={{ color: theme.muted }}>{caption}</Text>}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close model settings"
            onPress={close}
            disabled={saving}
            hitSlop={10}
          >
            <X size={22} color={theme.text} />
          </Pressable>
        </View>

        {harnesses.length > 0 && (
          <View style={styles.group}>
            <Text style={[styles.label, { color: theme.text }]}>
              Connection
            </Text>
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              style={styles.rail}
              contentContainerStyle={styles.choices}
            >
              {harnesses.map((item) => {
                const harness = harnessLabel(item);
                const label =
                  item.label && item.label !== harness
                    ? `${harness} · ${item.label}`
                    : harness;
                return choice(
                  label,
                  item.id === selection.connectionId,
                  () => {
                    if (item.id === selection.connectionId) return;
                    setQuery("");
                    setSelection({
                      connectionId: item.id,
                      model: defaultModelFor(item),
                      effort: null,
                    });
                  },
                  item.id,
                );
              })}
            </ScrollView>
          </View>
        )}

        <View style={styles.group}>
          <Text style={[styles.label, { color: theme.text }]}>Effort</Text>
          {selected && (selected.effortLevels?.length || selection.effort) ? (
            <View style={styles.choices}>
              {[null, ...(selected.effortLevels ?? [])].map((level) =>
                choice(
                  level === null && selected.defaultEffort
                    ? `${effortLabel(selected.defaultEffort)} (default)`
                    : effortLabel(level),
                  level === selection.effort,
                  () => setSelection((prev) => ({ ...prev, effort: level })),
                  level ?? "",
                ),
              )}
            </View>
          ) : (
            <Text style={{ color: theme.muted }}>
              This model uses the runtime’s effort setting.
            </Text>
          )}
        </View>

        <TextInput
          accessibilityLabel="Search models"
          placeholder="Search models"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          style={[
            styles.search,
            { color: theme.text, borderColor: theme.line },
          ]}
        />
        <FlatList
          data={matches}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(model) => model.id}
          ListEmptyComponent={
            <Text style={{ color: theme.muted }}>
              {models.length
                ? "No models match your search."
                : "No models available on this connection."}
            </Text>
          }
          renderItem={({ item }) => {
            const active = item.id === selection.model;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: active, disabled: saving }}
                disabled={saving}
                onPress={() => {
                  if (active) return;
                  setError("");
                  setSelection((prev) => ({
                    ...prev,
                    model: item.id,
                    effort: null,
                  }));
                }}
                style={[styles.model, { borderColor: theme.line }]}
              >
                <Text style={[styles.modelText, { color: theme.text }]}>
                  {item.id === "native-default" || item.id === "default"
                    ? item.name
                    : modelIdLabel(item.resolvedModel ?? item.name)}
                </Text>
                {active && <Check size={18} color={theme.brassText} />}
              </Pressable>
            );
          }}
        />
        {error ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.orange }}
          >
            {error}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!canSave || saving}
          onPress={() => void save()}
          style={[
            styles.save,
            { backgroundColor: theme.brass, opacity: canSave ? 1 : 0.4 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={theme.onBrass} />
          ) : (
            <Text style={[styles.label, { color: theme.onBrass }]}>
              {confirmLabel}
            </Text>
          )}
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 18, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  heading: { flex: 1, gap: 4 },
  title: { fontSize: 22, fontWeight: "700" },
  label: { fontSize: 15, fontWeight: "600" },
  group: { gap: 8 },
  rail: { flexGrow: 0 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  search: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  model: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modelText: { flex: 1, fontSize: 15 },
  save: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    minHeight: 46,
  },
});
