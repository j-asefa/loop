import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function recognitionClass(): (new () => Recognition) | undefined {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

export const voiceSupported = () => Boolean(recognitionClass());

/**
 * Hold-free dictation into the composer: tap to start, tap to stop. Uses the
 * browser's speech recognition, which may process audio with the browser
 * vendor's service; the button is hidden where it is unavailable.
 */
export function VoiceButton({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const base = useRef("");
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => () => recognition.current?.abort(), []);
  const Speech = recognitionClass();
  if (!Speech) return null;
  function start() {
    setError("");
    const r = new Speech!();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    base.current = value ? value.replace(/\s*$/, " ") : "";
    r.onresult = (event: any) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++)
        text += event.results[i][0].transcript;
      latest.current(base.current + text.trimStart());
    };
    r.onerror = (event: any) => {
      if (event.error !== "aborted" && event.error !== "no-speech")
        setError(
          event.error === "not-allowed"
            ? "Allow microphone access to dictate."
            : "Dictation stopped.",
        );
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Dictation is unavailable right now.");
    }
  }
  return (
    <>
      <button
        type="button"
        className={"icon-button voice-button" + (listening ? " listening" : "")}
        aria-label={listening ? "Stop dictation" : "Dictate"}
        aria-pressed={listening}
        disabled={disabled}
        onClick={() => (listening ? recognition.current?.stop() : start())}
      >
        {listening ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      {error && (
        <span className="field-hint voice-error" role="status">
          {error}
        </span>
      )}
    </>
  );
}
