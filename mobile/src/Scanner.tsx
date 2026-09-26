import { useRef } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Code, Screen, colors } from "./ui";

export function Scanner({
  onScan,
  onCancel,
}: {
  onScan: (data: string) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  // The camera reports the same code many times per second; act on it once.
  const handled = useRef(false);
  if (!permission) return <View style={styles.fill} />;
  if (!permission.granted)
    return (
      <Screen
        title="Allow the camera"
        body="Loop uses the camera only to scan the pairing code shown on your computer."
      >
        {permission.canAskAgain ? (
          <Button
            label="Allow camera"
            onPress={() => void requestPermission()}
          />
        ) : (
          <Button
            label="Open Settings"
            onPress={() => void Linking.openSettings()}
          />
        )}
        <Button label="Cancel" secondary onPress={onCancel} />
      </Screen>
    );
  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          handled.current = true;
          onScan(data);
        }}
      />
      <View style={[styles.panel, { paddingBottom: insets.bottom + 20 }]}>
        <Text style={styles.hint}>
          Scan the code from <Code>loop pair</Code> on your computer.
        </Text>
        <Button label="Cancel" secondary onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
  panel: {
    marginTop: "auto",
    backgroundColor: colors.background,
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  hint: { fontSize: 16, lineHeight: 23, color: colors.text },
});
