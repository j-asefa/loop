import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Pin both JS and WASM through the same installed package. Never use the
// library's default CDN URL, including when local asset loading fails.
const ready = prepareZXingModule({
  overrides: { locateFile: () => wasmUrl },
  fireImmediately: true,
});
let busy = false;
void ready
  .then(() => postMessage({ type: "ready" }))
  .catch(() => postMessage({ type: "error" }));
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    width: number;
    height: number;
    pixels: Uint8ClampedArray<ArrayBuffer>;
  }>,
) => {
  const value = event.data;
  if (
    busy ||
    !Number.isSafeInteger(value.id) ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 1024 ||
    value.height > 1024 ||
    !(value.pixels instanceof Uint8ClampedArray) ||
    !(value.pixels.buffer instanceof ArrayBuffer) ||
    value.pixels.length !== value.width * value.height * 4
  )
    return;
  busy = true;
  try {
    await ready;
    const result = await readBarcodes(
      new ImageData(value.pixels, value.width, value.height),
      {
        formats: ["QRCode"],
        maxNumberOfSymbols: 1,
        tryHarder: true,
      },
    );
    const text = result[0]?.text;
    postMessage({
      type: "result",
      id: value.id,
      text: typeof text === "string" && text.length <= 4096 ? text : null,
    });
  } catch {
    postMessage({ type: "error", id: value.id });
  } finally {
    busy = false;
  }
};
