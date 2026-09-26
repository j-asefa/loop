import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// The web app's light tokens (src/client/style.css), so native screens and the
// web view agree.
export const colors = {
  background: "#f4f4f2",
  text: "#1a1a1c",
  muted: "#63646a",
  line: "#dfdfdc",
  accent: "#c9a227",
  onAccent: "#1a1a1c",
  error: "#b4421e",
};

export function Screen({
  title,
  body,
  error,
  children,
}: {
  title: string;
  body?: ReactNode;
  error?: string;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <Text style={styles.wordmark}>loop</Text>
      <Text style={styles.title}>{title}</Text>
      {typeof body === "string" ? (
        <Text style={styles.body}>{body}</Text>
      ) : (
        body
      )}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

export function Button({
  label,
  onPress,
  secondary,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <View style={[styles.screen, styles.center]}>
      <ActivityIndicator color={colors.text} />
      <Text style={[styles.body, { marginTop: 16 }]}>{label}</Text>
    </View>
  );
}

export function Code({ children }: { children: string }) {
  return <Text style={styles.code}>{children}</Text>;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
  },
  center: { alignItems: "center", justifyContent: "center" },
  wordmark: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 12,
  },
  body: { fontSize: 16, lineHeight: 23, color: colors.muted },
  code: {
    fontFamily: "Courier",
    color: colors.text,
    fontWeight: "600",
  },
  error: { fontSize: 15, lineHeight: 21, color: colors.error, marginTop: 16 },
  actions: { marginTop: "auto", gap: 12 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  secondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonText: { color: colors.onAccent, fontSize: 16, fontWeight: "600" },
  secondaryText: { color: colors.text },
});
