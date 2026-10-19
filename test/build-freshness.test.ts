import { afterEach, expect, it, vi } from "vitest";
import { apiInWorkspace } from "../src/client/api";
import { buildObservationCurrent } from "../src/client/buildFreshness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([-300_000, 300_000])(
  "expires API observations despite device clock skew of %i ms and cache reuse",
  async (skew) => {
    let elapsed = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockReturnValue(100_000 + skew);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        elapsed += 5000; // Conservatively account for the whole request duration.
        return new Response(
          JSON.stringify({
            items: [
              {
                deployments: [
                  {
                    current: true,
                    status: "included",
                    checkedAt: 100_000,
                    validUntil: 120_000,
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const page = await apiInWorkspace("/projects/status", "");
    const observation = page.items[0].deployments[0];
    expect(buildObservationCurrent(observation)).toBe(true);
    // A deserialized record has no fresh network receipt; mounting it cannot
    // grant another lifetime. An in-memory cached view retains its deadline.
    expect(buildObservationCurrent(structuredClone(observation))).toBe(false);
    elapsed = 20_999;
    expect(buildObservationCurrent(observation)).toBe(true);
    elapsed = 21_001;
    expect(buildObservationCurrent(observation)).toBe(false);
  },
);

it("does not give delayed responses a new observation lifetime", async () => {
  let elapsed = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      elapsed += 25_000;
      return new Response(
        JSON.stringify({
          deployments: [
            {
              current: true,
              status: "included",
              checkedAt: 100_000,
              validUntil: 120_000,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const page = await apiInWorkspace("/projects/fixture/brief", "");
  expect(buildObservationCurrent(page.deployments[0])).toBe(false);
});
