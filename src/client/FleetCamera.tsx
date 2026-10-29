import { useEffect, useRef, useState } from "react";

/** All frames stay in a bounded local worker. Closing or hiding the view
 * releases the camera and worker, including late permission responses. */
export function FleetCamera({
  onValue,
  disabled = false,
}: {
  onValue: (value: string) => void;
  disabled?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onValue);
  callback.current = onValue;
  const generation = useRef(0);
  const cleanup = useRef<() => void>(() => {});
  const [state, setState] = useState<"off" | "starting" | "scanning">("off");
  const [error, setError] = useState("");
  function stop() {
    generation.current++;
    cleanup.current();
    cleanup.current = () => {};
    setState("off");
  }
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      generation.current++;
      cleanup.current();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  async function start() {
    stop();
    setError("");
    setState("starting");
    const current = generation.current;
    let stream: MediaStream | undefined, worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined,
      deadline: ReturnType<typeof setTimeout> | undefined;
    cleanup.current = () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      worker?.terminate();
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) {
        video.current.pause();
        video.current.srcObject = null;
        video.current.load();
      }
    };
    const live = () => current === generation.current && !document.hidden;
    const fail = () => {
      if (live()) {
        stop();
        setError(
          "Camera scanning is unavailable. Paste the pairing link below.",
        );
      }
    };
    deadline = setTimeout(fail, 30_000);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1024 },
          height: { ideal: 1024 },
        },
      });
      if (!live()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!video.current) {
        fail();
        return;
      }
      video.current.srcObject = stream;

      await video.current.play();
      if (!live()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      worker = new Worker(new URL("./fleet-qr-worker.ts", import.meta.url), {
        type: "module",
      });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        fail();
        return;
      }
      let id = 0,
        pending = 0;
      const next = () => {
        if (!live() || !worker || pending) return;
        try {
          const source = video.current;
          if (
            !source?.videoWidth ||
            !source.videoHeight ||
            source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          ) {
            timer = setTimeout(next, 250);
            return;
          }
          const ratio = Math.min(
            1,
            1024 / source.videoWidth,
            1024 / source.videoHeight,
          );
          canvas.width = Math.max(1, Math.floor(source.videoWidth * ratio));
          canvas.height = Math.max(1, Math.floor(source.videoHeight * ratio));
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          pending = ++id;

          clearTimeout(deadline);
          deadline = setTimeout(fail, 10_000);
          worker.postMessage(
            { id: pending, width: canvas.width, height: canvas.height, pixels },
            [pixels.buffer],
          );
        } catch {
          fail();
        }
      };
      clearTimeout(deadline);
      deadline = setTimeout(fail, 30_000);
      worker.onerror = fail;
      worker.onmessage = ({ data }) => {
        if (!live()) return;
        if (data.type === "error") {
          fail();
          return;
        }
        if (data.type === "ready") {
          clearTimeout(deadline);
          deadline = setTimeout(fail, 30_000);
          setState("scanning");
          next();
          return;
        }
        if (data.type !== "result" || data.id !== pending) return;
        clearTimeout(deadline);

        pending = 0;
        if (typeof data.text === "string") {
          const value = data.text;
          stop();
          callback.current(value);
        } else timer = setTimeout(next, 250);
      };
    } catch {
      fail();
    }
  }
  return (
    <div className="fleet-camera">
      <video
        ref={video}
        muted
        playsInline
        aria-label="Pairing QR camera"
        hidden={state === "off"}
      />
      {state === "off" ? (
        <button type="button" disabled={disabled} onClick={() => void start()}>
          Scan pairing QR
        </button>
      ) : (
        <>
          <p role="status">
            {state === "starting"
              ? "Starting camera…"
              : "Point the camera at the Loop pairing code."}
          </p>
          <button type="button" onClick={stop}>
            Stop camera
          </button>
        </>
      )}
      {error && <p role="status">{error}</p>}
      <small>
        Images are decoded on this device.{" "}
        <a
          href="/fleet-qr-licenses.txt"
          target="_blank"
          rel="noopener noreferrer"
        >
          Decoder licenses
        </a>
      </small>
    </div>
  );
}
