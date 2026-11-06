import { createServer, get } from "node:http";
import { once } from "node:events";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { compressResponse } from "../src/http-transfer.js";
import { cardsFixture } from "./helpers/cards-fixture.js";
import { rawGet } from "./helpers/raw-http.js";

{
  it(`companion compresses authenticated JSON once and keeps it private`, async () => {
    const fixture = await cardsFixture();
    const insert = fixture.db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',1)",
    );
    for (let i = 0; i < 50; i++)
      insert.run(`a${i}`, fixture.owner, `Agent ${i}`, `agent ${i}`);
    const url = fixture.transportOrigin + "/api/bootstrap";
    const plain = await rawGet(url, fixture.browser);
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const agents = JSON.parse(plain.body.toString()).agents;
    expect(agents).toHaveLength(50);
    for (const encoding of ["gzip", "br"]) {
      const compressed = await rawGet(url, {
        ...fixture.browser,
        "accept-encoding": encoding,
      });
      expect(compressed.status).toBe(200);
      expect(compressed.headers["cache-control"]).toBe("no-store");
      expect(compressed.headers["content-encoding"]).toBe(encoding);
      expect(compressed.headers.vary).toMatch(/Accept-Encoding/i);
      expect(compressed.headers["content-length"]).toBeUndefined();
      const decompress =
        encoding === "gzip" ? gunzipSync : brotliDecompressSync;
      expect(JSON.parse(decompress(compressed.body).toString()).agents).toEqual(
        agents,
      );
      expect(compressed.body.length).toBeLessThan(plain.body.length / 2);
    }
    const declined = await rawGet(url, {
      ...fixture.browser,
      "accept-encoding": "gzip;q=0, br;q=0, identity",
    });
    expect(declined.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(declined.body.toString()).agents).toEqual(agents);
  }, 30000);
}

it("preserves streams, downloads, byte ranges, small and already-encoded responses", async () => {
  const text = "fixture response ".repeat(1000);
  const precompressed = gzipSync(text);
  const server = createServer((req, res) =>
    compressResponse(req, res, () => {
      res.setHeader("Content-Type", "text/plain");
      switch (req.url) {
        case "/events":
          res.setHeader("Content-Type", "text/event-stream");
          res.write("data: first\n\n");
          return; // The reader must receive this before the stream ends.
        case "/download":
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="file.txt"',
          );
          break;
        case "/partial":
          res.statusCode = 206;
          res.setHeader(
            "Content-Range",
            `bytes 0-${text.length - 1}/${text.length}`,
          );
          break;
        case "/no-transform":
          res.setHeader("Cache-Control", "no-transform");
          break;
        case "/encoded":
          res.setHeader("Content-Encoding", "gzip");
          res.end(precompressed);
          return;
        case "/small":
          res.end("small");
          return;
      }
      res.setHeader("Content-Length", Buffer.byteLength(text));
      res.end(text);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of [
      "/download",
      "/partial",
      "/no-transform",
      "/range",
      "/small",
    ]) {
      const response = await rawGet(origin + path, {
        "accept-encoding": "gzip",
        ...(path === "/range" ? { range: "bytes=0-" } : {}),
      });
      expect(response.headers["content-encoding"], path).toBeUndefined();
      expect(response.body.toString()).toBe(path === "/small" ? "small" : text);
    }
    const encoded = await rawGet(origin + "/encoded", {
      "accept-encoding": "gzip",
    });
    expect(encoded.body).toEqual(precompressed);
    await new Promise<void>((resolve, reject) => {
      const req = get(
        origin + "/events",
        { headers: { "accept-encoding": "gzip" } },
        (res) => {
          res.once("data", (chunk) => {
            try {
              expect(res.headers["content-encoding"]).toBeUndefined();
              expect(chunk.toString()).toBe("data: first\n\n");
              resolve();
            } catch (error) {
              reject(error);
            } finally {
              res.destroy();
            }
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(2000, () =>
        req.destroy(new Error("Event stream was buffered")),
      );
      req.on("error", reject);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
