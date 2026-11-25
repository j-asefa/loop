import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ClipboardPaste, QrCode, ShieldCheck, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pairWithCompanion } from "../api/pairing";
import type { PairedSession } from "../api/types";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

export function PairingModal({
  theme,
  canClose,
  onClose,
  onPaired,
}: {
  theme: LoopTheme;
  canClose: boolean;
  onClose: () => void;
  onPaired: (session: PairedSession) => void;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitLink(raw: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await pairWithCompanion(raw);
      haptics.success();
      onPaired(session);
    } catch (err) {
      haptics.warning();
      setError(
        err instanceof Error ? err.message : "Could not pair with workspace.",
      );
      setScanning(false);
    } finally {
      setBusy(false);
    }
  }

  async function startScanner() {
    haptics.light();
    setError("");
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setError(
          "Camera permission is required to scan a QR code. You can paste a pairing link below instead.",
        );
        return;
      }
    }
    setScanning(true);
  }

  async function pasteFromClipboard() {
    haptics.light();
    const clip = await Clipboard.getStringAsync();
    if (!clip.trim()) {
      setError("Clipboard is empty. Run `loop pair` on your machine first.");
      return;
    }
    setLinkText(clip.trim());
    setError("");
    if (clip.includes("#pair=") || clip.includes("#fleet=")) {
      void submitLink(clip.trim());
    }
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <BlurView
        intensity={72}
        tint={theme.blurTint}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View
          style={[
            styles.sheetWrap,
            {
              paddingTop: Math.max(insets.top + 16, 28),
              paddingBottom: Math.max(insets.bottom + 16, 24),
            },
          ]}
        >
          <View
            style={[
              styles.card,
              { backgroundColor: theme.surface, borderColor: theme.line },
            ]}
          >
            <View style={styles.head}>
              <View style={styles.headLeft}>
                <ShieldCheck size={20} color={theme.brassText} />
                <Text style={[styles.title, { color: theme.text }]}>
                  Pair with Loop
                </Text>
              </View>
              {canClose && (
                <Pressable
                  onPress={() => {
                    haptics.light();
                    onClose();
                  }}
                  style={[
                    styles.closeBtn,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  <X size={16} color={theme.text} />
                </Pressable>
              )}
            </View>

            <Text style={[styles.subtitle, { color: theme.muted }]}>
              Run <Text style={{ color: theme.brassText }}>loop pair</Text> on
              your computer, then scan the QR code or paste the full pairing
              link. Credentials stay in iOS Keychain.
            </Text>

            {scanning ? (
              <View style={[styles.cameraBox, { borderColor: theme.brass }]}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    if (!busy && data) {
                      setScanning(false);
                      setLinkText(data);
                      void submitLink(data);
                    }
                  }}
                />
                <View style={styles.cameraOverlay}>
                  <View
                    style={[styles.cameraFrame, { borderColor: theme.brass }]}
                  />
                  <Pressable
                    onPress={() => setScanning(false)}
                    style={[
                      styles.cameraCancel,
                      { backgroundColor: theme.pillBg },
                    ]}
                  >
                    <Text style={{ color: theme.text, fontWeight: "600" }}>
                      Stop scanner
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.actionRow}>
                <Pressable
                  disabled={busy}
                  onPress={() => void startScanner()}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    {
                      backgroundColor: theme.brass,
                      opacity: pressed || busy ? 0.8 : 1,
                    },
                  ]}
                >
                  <QrCode size={17} color={theme.onBrass} />
                  <Text
                    style={[styles.primaryBtnText, { color: theme.onBrass }]}
                  >
                    Scan QR code
                  </Text>
                </Pressable>

                <Pressable
                  disabled={busy}
                  onPress={() => void pasteFromClipboard()}
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    {
                      backgroundColor: theme.soft,
                      borderColor: theme.line,
                      opacity: pressed || busy ? 0.8 : 1,
                    },
                  ]}
                >
                  <ClipboardPaste size={16} color={theme.text} />
                  <Text
                    style={[styles.secondaryBtnText, { color: theme.text }]}
                  >
                    Paste link
                  </Text>
                </Pressable>
              </View>
            )}

            <View style={styles.inputGroup}>
              <TextInput
                value={linkText}
                onChangeText={setLinkText}
                placeholder="https://…/#pair=…"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.bg,
                    borderColor: theme.line,
                    color: theme.text,
                  },
                ]}
              />
              <Pressable
                disabled={busy || !linkText.trim()}
                onPress={() => void submitLink(linkText)}
                style={({ pressed }) => [
                  styles.connectBtn,
                  {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                    opacity:
                      !linkText.trim() || busy ? 0.45 : pressed ? 0.8 : 1,
                  },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={theme.brassText} />
                ) : (
                  <Text
                    style={[styles.connectText, { color: theme.brassText }]}
                  >
                    Connect workspace
                  </Text>
                )}
              </Pressable>
            </View>

            {error ? (
              <Text style={[styles.errorText, { color: theme.orange }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    gap: 14,
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
    fontSize: 19,
    fontWeight: "700",
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 12,
    borderRadius: 14,
  },
  primaryBtnText: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  cameraBox: {
    height: 240,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1.5,
    position: "relative",
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 18,
  },
  cameraFrame: {
    width: 150,
    height: 150,
    borderRadius: 18,
    borderWidth: 2,
    marginTop: 12,
  },
  cameraCancel: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
  inputGroup: {
    gap: 10,
  },
  input: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 16,
  },
  connectBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderRadius: 14,
    borderWidth: 1,
  },
  connectText: {
    fontSize: 14.5,
    fontWeight: "700",
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
