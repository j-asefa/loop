import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { File as ExpoFile } from "expo-file-system";
import { Check, Mic, X } from "lucide-react-native";
import { haptics } from "../haptics";
import {
  buildVoiceRecordingFilename,
  formatVoiceDuration,
} from "../schedule-utils";
import type { LoopTheme } from "../theme";
import type { PickedFile } from "./AttachmentTray";

const MAX_RECORDING_SECONDS = 300; // 5 minutes keeps .m4a well below the 25 MB upload limit.

function deleteTempAudio(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const file = new ExpoFile(uri);
    if (file.exists) file.delete();
  } catch {
    // Best-effort temp cleanup.
  }
}

export function VoiceRecorderButton({
  theme,
  disabled,
  onRecorded,
  onError,
  onRecordingChange,
}: {
  theme: LoopTheme;
  disabled?: boolean;
  onRecorded: (file: PickedFile) => void;
  onError?: (message: string) => void;
  onRecordingChange?: (active: boolean) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const busyRef = useRef(false);
  const recordingRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const disabledRef = useRef(Boolean(disabled));
  const onRecordedRef = useRef(onRecorded);
  const onErrorRef = useRef(onError);
  const onRecordingChangeRef = useRef(onRecordingChange);
  disabledRef.current = Boolean(disabled);
  onRecordedRef.current = onRecorded;
  onErrorRef.current = onError;
  onRecordingChangeRef.current = onRecordingChange;

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetAudioMode = useCallback(() => {
    void setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
    }).catch(() => {});
  }, []);

  const finishRecording = useCallback(
    async (attach: boolean) => {
      if (busyRef.current || !recordingRef.current) return;
      busyRef.current = true;
      recordingRef.current = false;
      stopTimer();
      if (mountedRef.current) {
        setRecording(false);
        setElapsedSec(0);
      }
      try {
        await recorder.stop();
        const uri = recorder.uri;
        resetAudioMode();
        if (!mountedRef.current || !attach || disabledRef.current) {
          deleteTempAudio(uri);
          if (mountedRef.current) {
            if (attach && disabledRef.current) {
              haptics.warning();
              onErrorRef.current?.(
                "Could not attach voice note — attachment limit reached or send in progress.",
              );
            } else if (!attach) {
              haptics.light();
            }
          }
          return;
        }
        if (!uri) {
          onErrorRef.current?.("Could not save voice recording.");
        } else {
          haptics.success();
          onRecordedRef.current({
            uri,
            name: buildVoiceRecordingFilename(),
            mime: "audio/mp4",
            deleteAfterUpload: true,
          });
        }
      } catch (err) {
        resetAudioMode();
        if (attach && mountedRef.current) {
          haptics.warning();
          onErrorRef.current?.(
            err instanceof Error
              ? err.message
              : "Could not finish voice recording.",
          );
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          onRecordingChangeRef.current?.(false);
        }
      }
    },
    [recorder, resetAudioMode, stopTimer],
  );

  const finishRecordingRef = useRef(finishRecording);
  finishRecordingRef.current = finishRecording;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTimer();
      if (recordingRef.current) {
        recordingRef.current = false;
        try {
          void Promise.resolve(recorder.stop())
            .then(() => {
              try {
                deleteTempAudio(recorder.uri);
              } catch {
                // Ignore freed recorder property reads on unmount.
              }
            })
            .catch(() => {})
            .finally(() => {
              void setAudioModeAsync({
                allowsRecording: false,
                playsInSilentMode: true,
              }).catch(() => {});
            });
        } catch {
          void setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
          }).catch(() => {});
        }
      }
    };
  }, [recorder, stopTimer]);

  const startRecording = useCallback(async () => {
    if (busyRef.current || recordingRef.current || disabled) return;
    busyRef.current = true;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        haptics.warning();
        onErrorRef.current?.(
          "Microphone permission is required to record a voice note.",
        );
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      if (!mountedRef.current) {
        resetAudioMode();
        return;
      }
      recorder.record();
      startedAtRef.current = Date.now();
      recordingRef.current = true;
      setElapsedSec(0);
      setRecording(true);
      onRecordingChangeRef.current?.(true);
      haptics.medium();
      stopTimer();
      timerRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAtRef.current) / 1000);
        if (mountedRef.current) {
          setElapsedSec(secs);
        }
        if (secs >= MAX_RECORDING_SECONDS) {
          void finishRecordingRef.current(true);
        }
      }, 250);
    } catch (err) {
      recordingRef.current = false;
      stopTimer();
      resetAudioMode();
      if (mountedRef.current) {
        setRecording(false);
        setElapsedSec(0);
      }
      haptics.warning();
      onErrorRef.current?.(
        err instanceof Error ? err.message : "Could not start voice recording.",
      );
    } finally {
      busyRef.current = false;
    }
  }, [disabled, recorder, resetAudioMode, stopTimer]);

  if (recording) {
    return (
      <View
        style={[
          styles.recordingPill,
          {
            backgroundColor: theme.orangeSoft,
            borderColor: theme.orange,
          },
        ]}
      >
        <View style={[styles.liveDot, { backgroundColor: theme.orange }]} />
        <Text style={[styles.timerText, { color: theme.orange }]}>
          {formatVoiceDuration(elapsedSec)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Discard voice note"
          onPress={() => void finishRecording(false)}
          hitSlop={6}
          style={[
            styles.miniAction,
            { backgroundColor: theme.surface, borderColor: theme.line },
          ]}
        >
          <X size={13} color={theme.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach voice note"
          disabled={disabled}
          onPress={() => void finishRecording(true)}
          hitSlop={6}
          style={[
            styles.miniAction,
            { backgroundColor: theme.orange, opacity: disabled ? 0.4 : 1 },
          ]}
        >
          <Check size={13} color="#ffffff" strokeWidth={2.6} />
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Record voice note"
      disabled={disabled}
      onPress={() => void startRecording()}
      hitSlop={6}
      style={[styles.micBtn, disabled && { opacity: 0.4 }]}
    >
      <Mic size={16} color={theme.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  micBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  recordingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    paddingLeft: 8,
    paddingRight: 3,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  timerText: {
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  miniAction: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
});
