import "../deployment/environment.mjs";
// Three compiled companions, mobile browser emulation and a local TLS edge.
// QR decoding uses the bundled production worker/WASM with native detection
// absent. Harness, camera frames and peer network routing are deterministic
// fixtures; this does not certify physical cameras, providers or tunnels.
import { chromium, webkit, expect } from "@playwright/test";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createNet, connect } from "node:net";
import { createServer as createTls } from "node:tls";
import assert from "node:assert/strict";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import { testEnvironment } from "./test-runner.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import {
  fleetDeviceFromLink,
  fleetEnrollmentFromLink,
} from "../dist/shared/fleet-pairing.js";
const exec = promisify(execFile);
const base = await mkdtemp(join(tmpdir(), "loop55-fleet-browser-"));
const mapPath = join(base, "peers.json"),
  mapping = {},
  children = [];
const engine = process.env.LOOP55_BROWSER === "webkit" ? webkit : chromium;
let browser,
  edge,
  proxy,
  nextId = 0;
let checkpoint = "startup";
async function machine(name) {
  const dir = join(base, name),
    project = join(dir, "project");
  await mkdir(project, { recursive: true });
  await exec("git", ["init", "-q", project]);
  await exec("git", [
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "Fixture",
  ]);
  const origin = `https://${name}.fleet.example`;
  const child = fork(resolve("scripts/helpers/fleet-browser-host.mjs"), [], {
    execArgv: [],
    silent: true,
    env: {
      ...testEnvironment(process.env, "native"),
      LOOP55_PROFILE: "companion",
      LOOP55_DATA_DIR: dir,
      LOOP55_TEST_HARNESS: "codex",
      FLEET_FIXTURE_ORIGIN: origin,
      FLEET_FIXTURE_PROJECT: project,
      FLEET_FIXTURE_MAP: mapPath,
    },
  });
  children.push(child);
  const log = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (log.reduce((total, part) => total + part.length, 0) < 100_000)
        log.push(chunk);
    });
  const ready = await new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off("error", failed);
      child.off("exit", exited);
      child.off("message", message);
    };
    const failed = () => {
      clean();
      reject(new Error("Fixture companion startup failed"));
    };
    const exited = () => {
      clean();
      reject(new Error("Fixture companion exited before readiness"));
    };
    const message = (value) => {
      if (value.ready) {
        clean();
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("Fixture companion startup timed out"));
    }, 60_000);
    child.once("error", failed);
    child.once("exit", exited);
    child.on("message", message);
  }).catch(async (error) => {
    await writeFile(join(base, `${name}.log`), Buffer.concat(log));
    throw error;
  });
  mapping[origin] = ready.port;
  await writeFile(mapPath, JSON.stringify(mapping));
  const call = (method, value) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        child.off("message", reply);
        reject(new Error("Fixture command timed out"));
      }, 30_000);
      const reply = (message) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        child.off("message", reply);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      };
      child.on("message", reply);
      child.send({ id, method, value });
    });
  return { origin, call, child, port: ready.port };
}
async function openRuntimeMachines(page) {
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("button", { name: "Add machine", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Runtime machines", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Runtime machines", exact: true });
}
async function openSettings(page) {
  const machines = await openRuntimeMachines(page);
  await machines
    .getByRole("button", { name: /^(Add machine|Machines & fleet)$/ })
    .click();
  return page.getByRole("dialog", { name: "Machines & fleet", exact: true });
}
async function pair(page, url) {
  await page.goto(url);
  await page.getByRole("button", { name: "Pair and open Loop55" }).click();
  await expect(
    page.getByRole("button", { name: "Open settings", exact: true }),
  ).toBeVisible();
  assert(!new URL(page.url()).hash, "Pairing fragment was cleared");
}
function matrix(value) {
  const qr = new QRCode(-1, 0);
  qr.addData(value);
  qr.make();
  return qr.modules;
}
try {
  await writeFile(mapPath, "{}");
  await chmod(resolve("test/harness.mjs"), 0o755);
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=*.fleet.example",
    "-addext",
    "subjectAltName=DNS:*.fleet.example",
    "-keyout",
    join(base, "key.pem"),
    "-out",
    join(base, "cert.pem"),
  ]);
  const a = await machine("a"),
    b = await machine("b"),
    c = await machine("c");
  edge = createTls(
    {
      key: await readFile(join(base, "key.pem")),
      cert: await readFile(join(base, "cert.pem")),
    },
    (socket) => {
      const port = mapping[`https://${socket.servername}`];
      if (!port) return socket.destroy();
      const upstream = connect(port, "127.0.0.1");
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    },
  );
  await new Promise((resolve) => edge.listen(0, "127.0.0.1", resolve));
  proxy = createNet((client) =>
    client.once("data", (head) => {
      if (!/^CONNECT [a-z-]+\.fleet\.example:443 /.test(head.toString()))
        return client.destroy();
      const upstream = connect(edge.address().port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    }),
  );
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  browser = await engine.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const mobileContext = async () => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: engine === chromium,
    });
    await context.addInitScript(() =>
      Object.defineProperty(window, "BarcodeDetector", {
        value: undefined,
        configurable: true,
      }),
    );
    return context;
  };
  let context = await mobileContext();
  const requests = [],
    errors = [];
  context.on("request", (request) => requests.push(request));
  let page = await context.newPage();
  let recoveryNavigation = false;
  const recoveryError = (error) => {
    // The manual recovery case reloads the document and supersedes an active
    // read. WebKit reports those interrupted same-origin fetches as access
    // control errors. Use the shared classifier only during that explicit case.
    if (
      recoveryNavigation &&
      isWebKitNavigationFetchError(engine.name(), error, a.origin)
    )
      return;
    errors.push(error.message);
  };
  page.on("pageerror", recoveryError);
  checkpoint = "initial status failure recovery";
  // Inject at the companion response so service-worker fetches cannot bypass
  // a page-level Playwright route in either browser engine.
  await a.call("failStatus", true);
  await page.clock.install();
  await pair(page, (await a.call("pair")).url);
  await expect(
    page.getByRole("button", {
      name: "Directory status unavailable",
      exact: true,
    }),
  )
    .toBeVisible({ timeout: 15_000 })
    .catch(async (error) => {
      const safe = await page.evaluate(() => ({
        hidden: document.hidden,
        ready: document.readyState,
        authorityNotices: document.querySelectorAll(".fleet-authority-notice")
          .length,
      }));
      throw new Error(
        error.message +
          "\nSafe initial status diagnostics: " +
          JSON.stringify({
            ...safe,
            statusReads: await a.call("statusReads"),
            pageErrors: errors.length,
          }),
      );
    });
  const failedReads = await a.call("statusReads");
  assert(failedReads >= 3, "The initial read exhausted transport retries");
  // Use the browser's clock; the test host's wall clock can lag WebKit's
  // installed clock enough for pauseAt to reject a time already in the past.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  // Neither network recovery nor a timer in a hidden page should synthesize
  // a visibility/online event. Only the provider's visible-page retry recovers.
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    }),
  );
  await a.call("failStatus", false);
  await page.clock.runFor(60_000);
  assert.equal(
    await a.call("statusReads"),
    failedReads,
    "Hidden pages do not poll failed status",
  );
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    }),
  );
  await page.clock.runFor(30_000);
  await expect(
    page.getByRole("button", {
      name: "Directory status unavailable",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add machine", exact: true }),
  ).toHaveCount(0);
  const machines = await openRuntimeMachines(page);
  await expect(
    machines.getByRole("button", {
      name: "Add machine",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    await a.call("statusReads"),
    failedReads + 1,
    "One bounded visible retry recovers the failed first read",
  );
  const recoveredReads = await a.call("statusReads");
  await page.clock.runFor(60_000);
  assert.equal(
    await a.call("statusReads"),
    recoveredReads,
    "A healthy standalone gateway does not idle-poll",
  );
  await page.clock.resume();
  // Keep the accelerated polling clock out of the real-time reload case.
  // Re-pair a fresh context, then retain its device session across that reload.
  await context.close();
  assert.deepEqual(errors, []);
  context = await mobileContext();
  context.on("request", (request) => requests.push(request));
  page = await context.newPage();
  page.on("pageerror", recoveryError);
  await pair(page, (await a.call("pair")).url);
  checkpoint = "manual first-status recovery";
  await a.call("failStatus", true);
  recoveryNavigation = true;
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Directory status unavailable",
      exact: true,
    }),
  )
    .toBeVisible({ timeout: 15_000 })
    .catch(async (error) => {
      const safe = await page.evaluate(() => ({
        hidden: document.hidden,
        ready: document.readyState,
        authorityNotices: document.querySelectorAll(".fleet-authority-notice")
          .length,
      }));
      throw new Error(
        error.message +
          "\nSafe reload diagnostics: " +
          JSON.stringify({
            ...safe,
            statusReads: await a.call("statusReads"),
            pageErrors: errors.length,
          }),
      );
    });
  let sheet = await openSettings(page);
  await expect(
    sheet.getByText(
      "Directory status is unavailable. Refresh before making changes.",
      { exact: true },
    ),
  ).toBeVisible();
  await a.call("failStatus", false);
  await sheet
    .getByRole("button", { name: "Refresh fleet status", exact: true })
    .click();
  await expect(sheet.getByLabel("Machine name", { exact: true })).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  // Keep accelerated clock recovery separate from the real-time camera/media
  // journey. A fresh browser context also proves pairing from scratch.
  await context.close();
  assert.deepEqual(errors, []);
  context = await mobileContext();
  context.on("request", (request) => requests.push(request));
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await pair(page, (await a.call("pair")).url);
  sheet = await openSettings(page);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  const addMachine = page
    .getByRole("dialog", { name: "Runtime machines", exact: true })
    .getByRole("button", { name: "Add machine", exact: true });
  await expect(addMachine).toBeFocused();
  await addMachine.click();
  checkpoint = "create fleet";
  await sheet.getByLabel("Machine name", { exact: true }).fill("Laptop A");
  await sheet
    .getByLabel("This computer will control the fleet directory.", {
      exact: true,
    })
    .check();
  await sheet
    .getByRole("button", { name: "Create fleet", exact: true })
    .click();
  await expect(
    sheet.getByText("This session controls the directory", { exact: true }),
  ).toBeVisible();
  assert(
    !requests.some((request) =>
      /\.wasm(?:\?|$)|fleet-qr-worker/.test(request.url()),
    ),
    "Decoder loads only when scanning starts",
  );
  // Mock the prototype so every MediaDevices wrapper uses the fixture,
  // including after WebKit replaces its JS wrapper between camera starts.
  await page.evaluate(() =>
    Object.defineProperty(
      Object.getPrototypeOf(navigator.mediaDevices),
      "getUserMedia",
      {
        configurable: true,
        value: async () => {
          window.fleetDeniedCameraCalls =
            (window.fleetDeniedCameraCalls ?? 0) + 1;
          throw new DOMException("Fixture denial", "NotAllowedError");
        },
      },
    ),
  );
  await expect(
    sheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  await expect(sheet.locator(".fleet-camera")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Scan pairing QR" }).click();
  await expect(
    sheet.getByText(
      "Camera scanning is unavailable. Paste the pairing link below.",
    ),
  ).toBeVisible();
  assert.equal(await page.evaluate(() => window.fleetDeniedCameraCalls), 1);

  // Permission can resolve after the page hid. Release that late stream while
  // still hidden: the scanner must stop it without waiting for a render frame.
  await page.evaluate(() => {
    Object.defineProperty(
      Object.getPrototypeOf(navigator.mediaDevices),
      "getUserMedia",
      {
        configurable: true,
        value: () =>
          new Promise((resolve) => {
            window.releaseLateCamera = () => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 16;
              const stream = canvas.captureStream(0);
              window.lateCameraTracks = stream.getTracks();
              resolve(stream);
            };
          }),
      },
    );
  });
  await sheet
    .getByRole("button", { name: "Scan pairing QR", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Stop camera", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.releaseLateCamera();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.lateCameraTracks.every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const bLink = (await b.call("pair")).url;
  checkpoint = "scan and enroll";
  const device = fleetDeviceFromLink(bLink, b.origin);
  const modules = matrix(bLink);
  // Decode real QR pixels in the emitted worker under the production CSP.
  const worker = (await readdir("dist/web/assets")).find((name) =>
    /^fleet-qr-worker-.*\.js$/.test(name),
  );
  assert(worker, "Build includes the local decoder worker");
  const decoded = await page.evaluate(
    async ({ worker, modules }) => {
      const size = (modules.length + 8) * 4;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "black";
      modules.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) ctx.fillRect((x + 4) * 4, (y + 4) * 4, 4, 4);
        }),
      );
      const pixels = ctx.getImageData(0, 0, size, size).data;
      const decoder = new Worker(`/assets/${worker}`, { type: "module" });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Local decoder timed out")),
            20_000,
          );
          decoder.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Local decoder failed"));
          };
          decoder.onmessage = ({ data }) => {
            if (data.type === "ready")
              decoder.postMessage(
                { id: 1, pixels, width: size, height: size },
                [pixels.buffer],
              );
            else {
              clearTimeout(timer);
              if (data.type === "result") resolve(data.text);
              else reject(new Error("Local decoder refused the frame"));
            }
          };
        });
      } finally {
        decoder.terminate();
      }
    },
    { worker, modules },
  );
  assert(
    decoded === bLink,
    "Bundled decoder reads the actual pairing QR with no native BarcodeDetector",
  );
  await sheet.getByLabel("Pairing link", { exact: true }).fill(bLink);
  await sheet
    .getByRole("button", { name: "Inspect machine", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Discard link", exact: true })
    .click();
  await page.evaluate(
    ({ modules, fixtureMedia }) => {
      window.fleetCameraBlank = true;
      const size = (modules.length + 8) * 4;
      const sources = new WeakMap();
      if (fixtureMedia) {
        // WebKit's headless canvas capture can produce a live track but no
        // frames, even for a second video consumer. Supply that media boundary
        // deterministically; the production scanner and local QR worker still
        // consume real pixels. Chromium exercises actual canvas capture below.
        const video = document.querySelector(".fleet-camera video");
        const source = () => sources.get(video.srcObject);
        Object.defineProperties(video, {
          videoWidth: { configurable: true, get: () => source()?.width ?? 0 },
          videoHeight: { configurable: true, get: () => source()?.height ?? 0 },
          readyState: { configurable: true, get: () => (source() ? 4 : 0) },
        });
        const play = video.play.bind(video);
        video.play = () => (source() ? Promise.resolve() : play());
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (
          image,
          ...args
        ) {
          const fixture = image === video ? source() : undefined;
          return drawImage.call(this, fixture ?? image, ...args);
        };
      }
      Object.defineProperty(
        Object.getPrototypeOf(navigator.mediaDevices),
        "getUserMedia",
        {
          configurable: true,
          value: async () => {
            window.fleetSyntheticCameraCalls =
              (window.fleetSyntheticCameraCalls ?? 0) + 1;
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext("2d");
            let frame = 0;
            const draw = () => {
              ctx.fillStyle = "white";
              ctx.fillRect(0, 0, size, size);
              ctx.fillStyle = "black";
              if (!window.fleetCameraBlank)
                modules.forEach((row, y) =>
                  row.forEach((dark, x) => {
                    if (dark) ctx.fillRect((x + 4) * 4, (y + 4) * 4, 4, 4);
                  }),
                );
              // A real camera delivers changing frames. Keep the QR pixels intact
              // and change one corner outside its quiet zone on every frame.
              ctx.fillStyle = ++frame % 2 ? "#eee" : "white";
              ctx.fillRect(0, 0, 1, 1);
            };
            draw();
            // A camera emits frames continuously. Manual-only requestFrame()
            // can leave WebKit's synthetic stream without its first media frame.
            const stream = canvas.captureStream(10);
            sources.set(stream, canvas);
            window.fleetCameraFixture = {
              tracks: stream.getTracks(),
              timer: setInterval(draw, 150),
            };
            return stream;
          },
        },
      );
    },
    { modules, fixtureMedia: engine === webkit },
  );
  await page.evaluate(() => {
    window.fleetCameraBlank = true;
  });
  await sheet
    .getByRole("button", { name: "Scan pairing QR", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Stop camera", exact: true }),
  ).toBeVisible();
  try {
    await expect
      .poll(() =>
        sheet
          .locator(".fleet-camera video")
          .evaluate((video) => video.videoWidth),
      )
      .toBeGreaterThan(0);
  } catch (error) {
    // Report media state only; DOM text and URLs may contain pairing secrets.
    console.error(
      "Synthetic camera state:",
      await sheet.locator(".fleet-camera video").evaluate((video) => ({
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
        paused: video.paused,
        muted: video.muted,
        hidden: document.hidden,
        calls: window.fleetSyntheticCameraCalls,
        streamActive: video.srcObject?.active,
        tracks: video.srcObject?.getTracks().map((track) => ({
          kind: track.kind,
          readyState: track.readyState,
          enabled: track.enabled,
          muted: track.muted,
        })),
      })),
    );
    throw error;
  }
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    sheet.getByRole("button", { name: "Scan pairing QR", exact: true }),
  ).toBeVisible();
  assert(
    await page.evaluate(() =>
      window.fleetCameraFixture.tracks.every(
        (track) => track.readyState === "ended",
      ),
    ),
    "Hiding the scanner releases camera tracks",
  );
  await page.evaluate(() => {
    clearInterval(window.fleetCameraFixture.timer);
    window.fleetCameraBlank = false;
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sheet
    .getByRole("button", { name: "Scan pairing QR", exact: true })
    .click();
  await expect(
    sheet.getByRole("button", { name: "Confirm machine", exact: true }),
  )
    .toBeVisible({ timeout: 20_000 })
    .catch(async (error) => {
      console.error(
        "Restarted synthetic camera state:",
        await sheet.locator(".fleet-camera video").evaluate((video) => ({
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
          paused: video.paused,
          muted: video.muted,
          hidden: document.hidden,
          calls: window.fleetSyntheticCameraCalls,
          streamActive: video.srcObject?.active,
          tracks: video.srcObject?.getTracks().map((track) => ({
            kind: track.kind,
            readyState: track.readyState,
            enabled: track.enabled,
            muted: track.muted,
          })),
        })),
        "decoderWorkers:",
        page
          .workers()
          .filter((worker) => worker.url().includes("fleet-qr-worker")).length,
      );
      throw error;
    });
  assert(
    await page.evaluate(() =>
      window.fleetCameraFixture.tracks.every(
        (track) => track.readyState === "ended",
      ),
    ),
    "Successful scanning releases camera tracks",
  );
  assert.equal(await page.evaluate(() => window.fleetSyntheticCameraCalls), 2);
  await page.evaluate(() => clearInterval(window.fleetCameraFixture.timer));
  await expect
    .poll(
      () =>
        page
          .workers()
          .filter((worker) => worker.url().includes("fleet-qr-worker")).length,
    )
    .toBe(0);
  await sheet.getByLabel("Machine name", { exact: true }).fill("Computer B");
  await sheet
    .getByLabel(
      "I confirm this machine and authorize this controller to manage its peer membership within the selected scope.",
      { exact: true },
    )
    .check();
  await sheet
    .getByRole("button", { name: "Confirm machine", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Continue confirmed enrollment", exact: true })
    .click();
  await expect(
    sheet.getByText(
      "Enrollment complete. Directory acknowledgements are tracked separately.",
    ),
  ).toBeVisible();
  assert((await b.call("state")).state === "replica");
  const begin = requests.find((request) =>
    request.url().endsWith("/fleet/admin/enrollment/begin"),
  );
  assert(
    begin && !begin.postData().includes(device.secret),
    "Controller request excludes the device capability",
  );
  assert(!new URL(page.url()).hash);
  assert(
    !(await page.evaluate(
      (secret) =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }).includes(secret),
      device.secret,
    )),
  );
  assert(
    requests
      .filter((request) => /\.wasm(?:\?|$)/.test(request.url()))
      .every((request) => new URL(request.url()).origin === a.origin),
  );
  assert(
    !requests.some((request) => /jsdelivr|unpkg/.test(request.url())),
    "No CDN decoder request or fallback",
  );

  const bIdentity = (await b.call("state")).identity.machineId;
  checkpoint = "fresh origin and repair";
  const oldBOrigin = b.origin;
  b.origin = "https://b-new.fleet.example";
  await b.call("origin", b.origin);
  delete mapping[oldBOrigin];
  mapping[b.origin] = b.port;
  await writeFile(mapPath, JSON.stringify(mapping));
  assert(
    !(await context.cookies(b.origin)).some(
      (cookie) => cookie.name === "__Host-loop55",
    ),
    "New origin has no inherited device cookie",
  );
  const bContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: engine === chromium,
  });
  const bPage = await bContext.newPage();
  bPage.on("pageerror", (error) => errors.push(error.message));
  await pair(bPage, (await b.call("pair")).url);
  const bSheet = await openSettings(bPage);
  await expect(
    bSheet.getByText("Read-only directory replica — controlled by Laptop A", {
      exact: true,
    }),
  ).toBeVisible();
  await bSheet
    .getByText("Add this machine to an existing fleet", { exact: true })
    .click();
  await bSheet
    .getByLabel("Allow enrollment with the selected operations.", {
      exact: true,
    })
    .check();
  await b.call("holdMint");
  await bSheet
    .getByRole("button", { name: "Create enrollment-only link", exact: true })
    .click();
  await expect.poll(() => b.call("mintReady")).toBe(true);
  await bPage.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    bSheet.getByLabel("Allow enrollment with the selected operations.", {
      exact: true,
    }),
  ).not.toBeChecked();
  // Returning before the delayed response arrives must not revive its secret.
  await bPage.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await b.call("releaseMint");
  await expect(
    bSheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  await expect(
    bSheet.getByLabel("Enrollment-only link", { exact: true }),
  ).toHaveCount(0);
  await bSheet
    .getByLabel("Allow enrollment with the selected operations.", {
      exact: true,
    })
    .check();
  const minted = bPage.waitForResponse((response) =>
    response.url().endsWith("/fleet/admin/enrollment-link"),
  );
  await bSheet
    .getByRole("button", { name: "Create enrollment-only link", exact: true })
    .click();
  const mintResponse = await minted;
  assert.equal(
    mintResponse.status(),
    200,
    "Local enrollment-only mint succeeds",
  );
  await expect(bSheet.getByLabel("Enrollment-only link", { exact: true }))
    .toBeVisible({ timeout: 5000 })
    .catch(async (error) => {
      console.error({
        hidden: await bPage.evaluate(() => document.hidden),
        alerts: await bSheet.getByRole("alert").allTextContents(),
        state: (await b.call("state")).state,
      });
      throw error;
    });
  const enrollmentOnly = await bSheet
    .getByLabel("Enrollment-only link", { exact: true })
    .inputValue();
  assert(fleetEnrollmentFromLink(enrollmentOnly).origin === b.origin);
  assert.throws(() => fleetDeviceFromLink(enrollmentOnly, b.origin));
  await bSheet.getByRole("button", { name: "Hide link", exact: true }).click();
  await expect(
    bSheet.getByLabel("Enrollment-only link", { exact: true }),
  ).toHaveCount(0);

  await sheet.getByLabel("Pairing link", { exact: true }).fill(enrollmentOnly);
  await sheet
    .getByRole("button", { name: "Inspect machine", exact: true })
    .click();
  await expect(
    sheet.getByLabel("Connection purpose", { exact: true }),
  ).toHaveValue("repair");
  await sheet
    .getByLabel(
      "I confirm this machine and authorize this controller to manage its peer membership within the selected scope.",
      { exact: true },
    )
    .check();
  await sheet
    .getByRole("button", { name: "Confirm machine", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Continue confirmed enrollment", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await a.call("state")).directory.document.members.find(
          (member) => member.machineId === bIdentity,
        )?.origin,
    )
    .toBe(b.origin);
  assert(
    (await b.call("state")).identity.machineId === bIdentity,
    "Repair retains machine identity",
  );

  checkpoint = "enroll removal fixture";
  const cLink = (await c.call("pair")).url;
  const cIdentity = (await c.call("state")).identity.machineId;
  await expect(
    sheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  await sheet.getByLabel("Pairing link", { exact: true }).fill(cLink);
  await sheet
    .getByRole("button", { name: "Inspect machine", exact: true })
    .click();
  await sheet.getByLabel("Machine name", { exact: true }).fill("Computer C");
  await sheet
    .getByLabel(
      "I confirm this machine and authorize this controller to manage its peer membership within the selected scope.",
      { exact: true },
    )
    .check();
  await sheet
    .getByRole("button", { name: "Confirm machine", exact: true })
    .click();
  const cOperation = sheet
    .locator("article")
    .filter({ hasText: c.origin })
    .filter({
      has: page.getByRole("button", {
        name: "Continue confirmed enrollment",
        exact: true,
      }),
    });
  await cOperation
    .getByRole("button", { name: "Continue confirmed enrollment", exact: true })
    .click();
  await expect.poll(async () => (await c.call("state")).state).toBe("replica");
  const cDevice = fleetDeviceFromLink(cLink, c.origin);
  const cBegin = requests.findLast((request) =>
    request.url().endsWith("/fleet/admin/enrollment/begin"),
  );
  assert(
    cBegin && !cBegin.postData().includes(cDevice.secret),
    "Third-machine enrollment excludes its device secret",
  );

  checkpoint = "handoff controller";
  await expect(
    sheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  const handoffHead = (await a.call("state")).head;
  await expect
    .poll(async () => (await b.call("state")).head, { timeout: 20_000 })
    .toBe(handoffHead);
  await sheet
    .locator("article.connection-card")
    .filter({ hasText: "Computer B" })
    .getByRole("button", { name: "Transfer directory control", exact: true })
    .click();
  await sheet.getByLabel("I confirm this change.", { exact: true }).check();
  await sheet
    .getByRole("button", { name: "Confirm handoff", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Send confirmed handoff", exact: true })
    .click();
  await expect(
    sheet.getByText("Read-only directory replica — controlled by Computer B", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Remove machine", exact: true }),
  ).toHaveCount(0);
  await bSheet
    .getByRole("button", { name: "Refresh fleet status", exact: true })
    .click();
  checkpoint = "new controller status";
  await expect(
    bSheet.getByText("This session controls the directory", { exact: true }),
  ).toBeVisible();
  checkpoint = "remove third machine";
  await expect
    .poll(
      async () =>
        (await b.call("deliveries")).items.find(
          (item) => item.peerId === cIdentity,
        )?.state,
      { timeout: 20_000 },
    )
    .toBe("acked");
  // Keep a second sheet open with the acknowledged revision. Removing C in
  // the first tab must invalidate that receipt when authority refreshes.
  const observerPage = await bContext.newPage();
  observerPage.on("pageerror", (error) => errors.push(error.message));
  await observerPage.goto(b.origin);
  const observerSheet = await openSettings(observerPage);
  const synchronization = observerSheet.locator("section").filter({
    has: observerPage.getByRole("heading", {
      name: "Directory synchronization",
      exact: true,
    }),
  });
  await expect(
    synchronization
      .locator("article")
      .filter({ hasText: "Computer C" })
      .getByText("Directory acknowledged", { exact: true }),
  ).toBeVisible();
  delete mapping[c.origin];
  await writeFile(mapPath, JSON.stringify(mapping));
  await b.call("holdDeliveries");
  await bSheet
    .locator("article.connection-card")
    .filter({ hasText: "Computer C" })
    .getByRole("button", { name: "Remove machine", exact: true })
    .click();
  await bSheet.getByLabel("I confirm this change.", { exact: true }).check();
  await bSheet
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await b.call("state")).directory.document.tombstones.includes(cIdentity),
    )
    .toBe(true);
  const removedHead = (await b.call("state")).head;
  const authorityRefresh = observerPage.waitForResponse((response) =>
    response.url().endsWith("/fleet/admin/state"),
  );
  await observerPage.evaluate(() => window.dispatchEvent(new Event("online")));
  assert.equal((await (await authorityRefresh).json()).head, removedHead);
  await expect(
    observerSheet.getByText("Refreshing directory synchronization…", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    observerSheet.getByText("Directory acknowledged", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => b.call("deliveriesHeld")).toBeGreaterThan(0);
  await b.call("releaseDeliveries");
  const removedDelivery = synchronization
    .locator("article")
    .filter({ hasText: cIdentity });
  await expect(
    removedDelivery.getByText("Revoked from this directory", { exact: true }),
  ).toBeVisible();
  await expect(
    removedDelivery.getByText("Directory acknowledged", { exact: true }),
  ).toHaveCount(0);
  await expect(
    removedDelivery.getByRole("button", {
      name: "Retry directory synchronization",
      exact: true,
    }),
  ).toBeEnabled();
  mapping[c.origin] = c.port;
  await writeFile(mapPath, JSON.stringify(mapping));
  await removedDelivery
    .getByRole("button", {
      name: "Retry directory synchronization",
      exact: true,
    })
    .click();
  await expect(
    bSheet.getByText("Revoked from this directory", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await c.call("state")).state).toBe("removed");
  const cContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: engine === chromium,
  });
  const cPage = await cContext.newPage();
  cPage.on("pageerror", (error) => errors.push(error.message));
  await pair(cPage, (await c.call("pair")).url);
  const cSheet = await openSettings(cPage);
  await expect(
    cSheet.getByText("Recover without the old controller", { exact: true }),
  ).toHaveCount(0);
  await expect(
    cSheet.getByText("This machine was removed from the fleet.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await a.call("state")).directory.document.tombstones.includes(cIdentity),
    )
    .toBe(true);
  // Retain A's valid local device and replica grant while the controller's
  // address becomes unreachable. Recovery is never attempted by removed C.
  delete mapping[b.origin];
  await writeFile(mapPath, JSON.stringify(mapping));
  await sheet
    .getByRole("button", { name: "Refresh fleet status", exact: true })
    .click();
  await expect(
    sheet.getByText("Read-only directory replica — controlled by Computer B", {
      exact: true,
    }),
  ).toBeVisible();
  await sheet
    .getByText("Recover without the old controller", { exact: true })
    .click();
  checkpoint = "explicit recovery";
  await expect(
    sheet.getByRole("button", { name: "Refresh fleet status", exact: true }),
  ).toBeEnabled();
  await sheet
    .getByLabel("Recovered machine name", { exact: true })
    .fill("Recovered A");
  await sheet
    .getByLabel(
      "I authorize recovery on this machine and understand other machines must consent again.",
      { exact: true },
    )
    .check();
  await sheet
    .getByRole("button", { name: "Recover this machine", exact: true })
    .click();
  await expect(
    sheet.getByText("This session controls the directory", { exact: true }),
  ).toBeVisible();
  const recovered = await a.call("state");
  assert(
    recovered.directory.document.members.length === 1,
    "Recovery restores no other machine grant",
  );
  assert(
    recovered.unconfirmed.some((member) => member.machineId === bIdentity),
    "Old members remain unconfirmed after recovery",
  );
  assert(
    recovered.directory.document.tombstones.includes(cIdentity),
    "Explicit recovery retains known removal tombstones",
  );
  checkpoint = "refresh loaded delivery pages";
  // Seed retained delivery records, not workspace agents or network peers.
  // Reads and refresh still cross the authenticated production HTTP facade.
  const lastDelivery = await a.call("seedDeliveryPages");
  await sheet
    .getByRole("button", { name: "Refresh fleet status", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "More directory deliveries", exact: true })
    .click();
  const laterDelivery = sheet
    .locator("article.connection-card")
    .filter({ hasText: lastDelivery });
  await expect(
    laterDelivery.getByText("Directory synchronization pending", {
      exact: true,
    }),
  ).toBeVisible();
  await a.call("ackDelivery", lastDelivery);
  await sheet
    .getByRole("button", { name: "Refresh fleet status", exact: true })
    .click();
  await expect(
    laterDelivery.getByText("Directory acknowledged", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    `PASS (${engine.name()}): local pairing, fleet creation, QR worker without native detection, ${engine === webkit ? "media-element frame fixture" : "canvas capture stream"}, camera cleanup/denied-camera paste fallback, enrollment capability isolation, replica authority, fresh-origin pairing and enrollment-only repair, handoff, removal and explicit recovery through three compiled companions. Local TLS and injected peer transport fixtures; no physical camera or live provider/tunnel claims.`,
  );
} catch (error) {
  // Playwright snapshots can include a fixture pairing textarea. Keep even
  // these disposable capabilities out of command logs and failure reports.
  console.error(
    checkpoint +
      ": " +
      String(error?.message ?? error).replace(
        /#(?:fleet|pair|enroll)=[A-Za-z0-9_-]+/g,
        "#capability=[REDACTED]",
      ),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  edge?.close();
  proxy?.close();
  await rm(base, { recursive: true, force: true });
}
