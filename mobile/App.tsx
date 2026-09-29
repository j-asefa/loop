import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  check,
  openUrl,
  pair,
  parsePairingCode,
  sameOrigin,
  type Health,
  type Pairing,
} from "./src/connection";
import { clearPairing, loadPairing, savePairing } from "./src/storage";
import { useDeviceLock } from "./src/lock";
import { Scanner } from "./src/Scanner";
import { Busy, Button, Code, Screen, colors } from "./src/ui";

type Mode =
  | "starting"
  | "welcome"
  | "scan"
  | "pairing"
  | "web"
  | "unreachable"
  | "revoked";

const deviceName =
  Platform.OS === "ios" ? "Loop app (iOS)" : "Loop app (Android)";
const POLL_MS = 15000;

async function probe(pairing: Pairing, attempts: number): Promise<Health> {
  for (let attempt = 1; ; attempt++) {
    const health = await check(pairing);
    if (health !== "unreachable" || attempt >= attempts) return health;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

function Shell() {
  const [mode, setMode] = useState<Mode>("starting");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [webKey, setWebKey] = useState(0);
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const latest = useRef<Pairing | null>(null);
  const back = useRef<Mode>("welcome");
  const checking = useRef(false);
  // The web view keeps showing its error page after a failed load, so a
  // successful probe must reload it.
  const webFailed = useRef(false);
  const lastReload = useRef(0);
  const lock = useDeviceLock();
  // Only a paired workspace is worth protecting.
  const guarded = lock.locked && pairing !== null;

  const verify = useCallback(async (attempts: number) => {
    const current = latest.current;
    if (!current || checking.current) return;
    checking.current = true;
    try {
      const health = await probe(current, attempts);
      if (latest.current !== current) return;
      // Never pull the user out of the scanner or an in-flight pairing.
      const monitored = (m: Mode) =>
        m === "starting" || m === "web" || m === "unreachable";
      if (health === "revoked") {
        latest.current = null;
        setPairing(null);
        await clearPairing();
        setMode((m) => (monitored(m) ? "revoked" : m));
      } else {
        // Reloads are spaced out so a page that keeps failing waits for the next poll.
        if (
          health === "connected" &&
          webFailed.current &&
          Date.now() - lastReload.current > 10000
        ) {
          webFailed.current = false;
          lastReload.current = Date.now();
          setWebKey((k) => k + 1);
        }
        setMode((m) =>
          monitored(m) ? (health === "connected" ? "web" : "unreachable") : m,
        );
      }
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    loadPairing()
      .then((stored) => {
        if (!stored) return setMode("welcome");
        latest.current = stored;
        setPairing(stored);
        void verify(1);
      })
      .catch(() => setMode("welcome"));
  }, [verify]);

  useEffect(() => {
    if (mode !== "web" && mode !== "unreachable") return;
    // In the web view a few retries ride out network blips; on the reconnect
    // screen one success is enough to return.
    const attempts = mode === "web" ? 4 : 1;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void verify(attempts);
    }, POLL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void verify(2);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [mode, verify]);

  const { unlock } = lock;
  useEffect(() => {
    if (guarded && AppState.currentState === "active") void unlock();
  }, [guarded, unlock]);

  const startScan = useCallback(() => {
    if (mode !== "scan" && mode !== "pairing") back.current = mode;
    setMode("scan");
  }, [mode]);

  const leaveScanner = useCallback(
    () => setMode(back.current === "starting" ? "welcome" : back.current),
    [],
  );

  // Android's back button: leave the scanner, or go back inside the web app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (guarded) return false;
        if (mode === "scan") {
          leaveScanner();
          return true;
        }
        if (mode === "web" && canGoBack.current) {
          web.current?.goBack();
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [mode, leaveScanner, guarded]);

  const fail = (message: string) => {
    leaveScanner();
    Alert.alert("Couldn't connect", message);
  };

  const onScan = async (data: string) => {
    let code;
    try {
      code = parsePairingCode(data);
    } catch (e) {
      return fail((e as Error).message);
    }
    setMode("pairing");
    try {
      const next = await pair(code, deviceName);
      await savePairing(next);
      lock.release();
      latest.current = next;
      setPairing(next);
      setWebKey((k) => k + 1);
      setMode("web");
    } catch (e) {
      fail((e as Error).message);
    }
  };

  // The workspace stays loaded under the lock so unlocking doesn't reload it.
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={guarded}
        importantForAccessibility={guarded ? "no-hide-descendants" : "auto"}
      >
        {content()}
      </View>
      {guarded ? (
        <View style={StyleSheet.absoluteFill}>
          <Screen
            title="Loop is locked"
            body="Confirm it's you with Face ID, Touch ID or your device passcode to open your workspace."
            error={lock.error}
          >
            <Button label="Unlock" onPress={() => void unlock()} />
          </Screen>
        </View>
      ) : null}
    </View>
  );

  function content() {
    if (mode === "starting")
      return <Busy label="Connecting to your computer…" />;
    if (mode === "pairing") return <Busy label="Pairing…" />;
    if (mode === "scan")
      return (
        <Scanner onScan={(data) => void onScan(data)} onCancel={leaveScanner} />
      );
    if (mode === "web" && pairing)
      return (
        // iOS reports safe areas to the page (viewport-fit=cover); Android's web
        // view may not, so keep the page clear of the system bars there.
        <View
          style={{
            flex: 1,
            backgroundColor: colors.background,
            paddingTop: Platform.OS === "android" ? insets.top : 0,
            paddingBottom: Platform.OS === "android" ? insets.bottom : 0,
          }}
        >
          <WebView
            key={webKey}
            ref={web}
            style={{ flex: 1, backgroundColor: colors.background }}
            onNavigationStateChange={(state) => {
              canGoBack.current = state.canGoBack;
            }}
            source={{
              uri: openUrl(pairing),
              headers: { Authorization: "Bearer " + pairing.token },
            }}
            onShouldStartLoadWithRequest={(request) => {
              if (
                sameOrigin(request.url, pairing.origin) ||
                /^(about|blob|data):/.test(request.url)
              )
                return true;
              // Only the paired workspace runs inside the app; links open outside it.
              if (
                request.isTopFrame &&
                /^(https?|mailto|tel):/.test(request.url)
              )
                void Linking.openURL(request.url);
              return false;
            }}
            onOpenWindow={({ nativeEvent }) => {
              // Provider login opens in the system browser without the paired
              // workspace's Authorization header, including target=_blank links.
              if (/^https?:/.test(nativeEvent.targetUrl))
                void Linking.openURL(nativeEvent.targetUrl);
            }}
            onMessage={(event) => {
              if (!sameOrigin(event.nativeEvent.url, pairing.origin)) return;
              try {
                if (JSON.parse(event.nativeEvent.data)?.type === "loop:scan")
                  startScan();
              } catch {
                // Not a shell message.
              }
            }}
            // Errors for a load arrive after its start and before its finish.
            onLoadStart={() => {
              webFailed.current = false;
            }}
            onError={() => {
              webFailed.current = true;
              void verify(2);
            }}
            onHttpError={(event) => {
              if (event.nativeEvent.statusCode < 500) return;
              webFailed.current = true;
              void verify(2);
            }}
            onContentProcessDidTerminate={() => setWebKey((k) => k + 1)}
            onRenderProcessGone={() => setWebKey((k) => k + 1)}
            pullToRefreshEnabled
            setSupportMultipleWindows={false}
            allowsInlineMediaPlayback
            webviewDebuggingEnabled={__DEV__}
          />
        </View>
      );
    if (mode === "unreachable" && pairing)
      return (
        <Screen
          title="Can't reach your computer"
          body={
            <Text style={{ fontSize: 16, lineHeight: 23, color: colors.muted }}>
              It may be asleep or offline, or Loop's tunnel address changed
              after a restart. Run <Code>loop pair</Code> on your computer and
              scan the new code.{"\n\n"}Last address:{" "}
              {new URL(pairing.origin).host}
            </Text>
          }
        >
          <Button label="Scan new code" onPress={startScan} />
          <Button label="Try again" secondary onPress={() => void verify(1)} />
        </Screen>
      );
    if (mode === "revoked")
      return (
        <Screen
          title="This phone was signed out"
          body="It was revoked on your computer, its pairing expired, or Loop was restarted. Run loop pair on your computer and scan the code to pair again."
        >
          <Button label="Scan pairing code" onPress={startScan} />
        </Screen>
      );
    return (
      <Screen
        title="Pair with your computer"
        body={
          <Text style={{ fontSize: 16, lineHeight: 23, color: colors.muted }}>
            On your computer, run <Code>loop codex</Code> (or{" "}
            <Code>claude</Code>, <Code>pi</Code>, <Code>opencode</Code>). If
            Loop is already running, run <Code>loop pair</Code>. Then scan the
            code it shows.
          </Text>
        }
      >
        <Button label="Scan pairing code" onPress={startScan} />
      </Screen>
    );
  }
}
