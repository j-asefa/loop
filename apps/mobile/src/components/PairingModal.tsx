import React, { useEffect, useRef, useState } from "react";
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
import {
  CheckCircle2,
  ClipboardPaste,
  Link2,
  QrCode,
  ShieldCheck,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  pairWithCompanion,
  pairWithOriginAndToken,
  probeWorkspaceUrl,
  tryParsePairingLink,
} from "../api/pairing";
import type { PairedSession } from "../api/types";
import { LAYERS } from "../layers";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

type PairMode = "url" | "qr";

export function PairingModal({
  theme,
  canClose,
  initialUrl = "",
  onClose,
  onPaired,
}: {
  theme: LoopTheme;
  canClose: boolean;
  initialUrl?: string;
  onClose: () => void;
  onPaired: (session: PairedSession) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<PairMode>("url");
  const [urlText, setUrlText] = useState(initialUrl);
  const [tokenText, setTokenText] = useState("");
  const [verifiedOrigin, setVerifiedOrigin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const pendingAttempt = useRef<AbortController | null>(null);
  const redeemingRef = useRef(false);
  const closedRef = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialUrl) setUrlText(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      pendingAttempt.current?.abort();
    };
  }, []);

  async function connectWithUrl(rawUrl: string, rawToken = tokenText) {
    if (closedRef.current || pendingAttempt.current) return;
    const attempt = new AbortController();
    pendingAttempt.current = attempt;
    const { signal } = attempt;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, 20_000);
    const lockRedemption = () => {
      redeemingRef.current = true;
      setRedeeming(true);
    };
    const commit = async (session: PairedSession) => {
      if (signal.aborted || closedRef.current) return;
      clearTimeout(deadline);
      lockRedemption();
      await onPaired(session);
      haptics.success();
    };
    setBusy(true);
    setError("");
    try {
      const { origin, pairing } = tryParsePairingLink(rawUrl);
      if (pairing) {
        lockRedemption();
        await commit(await pairWithCompanion(rawUrl, signal));
        return;
      }

      if (rawToken.trim()) {
        lockRedemption();
        await commit(await pairWithOriginAndToken(origin, rawToken, signal));
        return;
      }

      // Bare workspace URL: check reachability and any existing cookie session
      const probe = await probeWorkspaceUrl(rawUrl, signal);
      if (signal.aborted) return;
      if (probe.session) {
        await commit(probe.session);
        return;
      }
      setVerifiedOrigin(probe.origin);
      haptics.light();
    } catch (err) {
      if (closedRef.current || (signal.aborted && !timedOut)) return;
      haptics.warning();
      setError(
        timedOut
          ? "The connection timed out. Check the workspace URL before using a new pairing link."
          : err instanceof Error
            ? err.message
            : "Could not connect to workspace.",
      );
      if (mode === "qr") setMode("url");
    } finally {
      clearTimeout(deadline);
      pendingAttempt.current = null;
      redeemingRef.current = false;
      if (!closedRef.current) {
        setRedeeming(false);
        setBusy(false);
      }
    }
  }

  async function switchToQr() {
    haptics.selection();
    setError("");
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setError(
          "Camera permission is required to scan QR codes. You can paste a URL instead.",
        );
        return;
      }
    }
    setMode("qr");
  }

  async function pasteFromClipboard() {
    haptics.light();
    const clip = (await Clipboard.getStringAsync()).trim();
    if (closedRef.current) return;
    if (!clip) {
      setError("Clipboard is empty. Run `loop pair` on your machine first.");
      return;
    }
    setError("");
    if (verifiedOrigin && !clip.includes("://") && !clip.includes(".")) {
      setTokenText(clip);
      void connectWithUrl(verifiedOrigin, clip);
      return;
    }
    setUrlText(clip);
    if (
      clip.includes("#pair=") ||
      clip.includes("?pair=") ||
      clip.includes("#fleet=")
    ) {
      void connectWithUrl(clip);
    }
  }

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: LAYERS.pairing }]}>
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
                  accessibilityLabel="Close pairing"
                  disabled={redeeming}
                  onPress={() => {
                    if (redeemingRef.current) return;
                    closedRef.current = true;
                    pendingAttempt.current?.abort();
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

            {/* Mode Segmented Toggle: Pair via URL | Scan QR */}
            <View
              style={[
                styles.segmentRow,
                { backgroundColor: theme.soft, borderColor: theme.line },
              ]}
            >
              <Pressable
                onPress={() => {
                  haptics.selection();
                  setMode("url");
                }}
                style={[
                  styles.segmentBtn,
                  mode === "url" && {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <Link2
                  size={15}
                  color={mode === "url" ? theme.brassText : theme.muted}
                />
                <Text
                  style={[
                    styles.segmentLabel,
                    { color: mode === "url" ? theme.brassText : theme.muted },
                  ]}
                >
                  Pair via URL
                </Text>
              </Pressable>

              <Pressable
                onPress={() => void switchToQr()}
                style={[
                  styles.segmentBtn,
                  mode === "qr" && {
                    backgroundColor: theme.attention,
                    borderColor: theme.attentionLine,
                  },
                ]}
              >
                <QrCode
                  size={15}
                  color={mode === "qr" ? theme.brassText : theme.muted}
                />
                <Text
                  style={[
                    styles.segmentLabel,
                    { color: mode === "qr" ? theme.brassText : theme.muted },
                  ]}
                >
                  Scan QR
                </Text>
              </Pressable>
            </View>

            {mode === "qr" ? (
              <View style={[styles.cameraBox, { borderColor: theme.brass }]}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    if (!busy && data) {
                      setMode("url");
                      setUrlText(data);
                      void connectWithUrl(data);
                    }
                  }}
                />
                <View style={styles.cameraOverlay}>
                  <View
                    style={[styles.cameraFrame, { borderColor: theme.brass }]}
                  />
                  <Text style={styles.cameraHint}>
                    Point at the QR code from `loop pair`
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.form}>
                <Text style={[styles.subtitle, { color: theme.muted }]}>
                  Paste the full link from{" "}
                  <Text style={{ color: theme.brassText }}>loop pair</Text>{" "}
                  (including <Text style={{ color: theme.text }}>#pair=…</Text>
                  ), or enter your workspace URL.
                </Text>

                <View
                  style={[
                    styles.urlInputRow,
                    { backgroundColor: theme.soft, borderColor: theme.line },
                  ]}
                >
                  <TextInput
                    value={urlText}
                    onChangeText={(val) => {
                      setUrlText(val);
                      setVerifiedOrigin(null);
                      setError("");
                    }}
                    placeholder="https://your-loop-host/#pair=…"
                    placeholderTextColor={theme.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={[styles.urlInput, { color: theme.text }]}
                  />
                  <Pressable
                    onPress={() => void pasteFromClipboard()}
                    style={[
                      styles.pastePill,
                      {
                        backgroundColor: theme.surface,
                        borderColor: theme.line,
                      },
                    ]}
                  >
                    <ClipboardPaste size={14} color={theme.brassText} />
                    <Text
                      style={[styles.pasteText, { color: theme.brassText }]}
                    >
                      Paste
                    </Text>
                  </Pressable>
                </View>

                {verifiedOrigin && (
                  <View
                    style={[
                      styles.verifiedBox,
                      {
                        backgroundColor: theme.greenSoft,
                        borderColor: theme.green,
                      },
                    ]}
                  >
                    <View style={styles.verifiedHead}>
                      <CheckCircle2 size={15} color={theme.green} />
                      <Text
                        style={[styles.verifiedTitle, { color: theme.green }]}
                      >
                        Reached {verifiedOrigin.replace(/^https?:\/\//, "")}
                      </Text>
                    </View>
                    <Text style={[styles.verifiedBody, { color: theme.text }]}>
                      Run{" "}
                      <Text style={{ color: theme.brassText }}>loop pair</Text>{" "}
                      on that machine and paste the full link or the token after{" "}
                      <Text style={{ fontWeight: "700" }}>#pair=</Text>:
                    </Text>
                    <TextInput
                      value={tokenText}
                      onChangeText={setTokenText}
                      placeholder="Paste pairing token or full #pair= link"
                      placeholderTextColor={theme.muted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[
                        styles.tokenInput,
                        {
                          backgroundColor: theme.surface,
                          borderColor: theme.line,
                          color: theme.text,
                        },
                      ]}
                    />
                  </View>
                )}

                <Pressable
                  disabled={busy || !urlText.trim()}
                  onPress={() => void connectWithUrl(urlText, tokenText)}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    {
                      backgroundColor: theme.brass,
                      opacity:
                        !urlText.trim() || busy ? 0.4 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={theme.onBrass} />
                  ) : (
                    <Text
                      style={[styles.primaryBtnText, { color: theme.onBrass }]}
                    >
                      {verifiedOrigin ? "Pair & connect" : "Connect workspace"}
                    </Text>
                  )}
                </Pressable>
              </View>
            )}

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
  segmentRow: {
    flexDirection: "row",
    padding: 4,
    borderRadius: 14,
    borderWidth: 1,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "transparent",
  },
  segmentLabel: {
    fontSize: 13.5,
    fontWeight: "700",
  },
  form: {
    gap: 12,
  },
  subtitle: {
    fontSize: 13.5,
    lineHeight: 19.5,
  },
  urlInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 14,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  urlInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 6,
  },
  pastePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  pasteText: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  verifiedBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  verifiedHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  verifiedTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  verifiedBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  tokenInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 15,
  },
  primaryBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
    borderRadius: 14,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: "700",
  },
  cameraBox: {
    height: 250,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1.5,
    position: "relative",
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 20,
  },
  cameraFrame: {
    width: 155,
    height: 155,
    borderRadius: 18,
    borderWidth: 2,
    marginTop: 10,
  },
  cameraHint: {
    color: "#ffffff",
    fontSize: 12.5,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
