import { describe, expect, it } from "vitest";
import { createMarketContextHandler } from "@/app/api/market/context/route";
import { getMarketContext } from "@/lib/services/market-context";

const NOW = "2026-11-12T20:00:00.000Z";

describe("market context API", () => {
  it("returns the bounded domain envelope with no-store semantics", async () => {
    const result = await getMarketContext({
      getSnapshots: async () => new Map(),
      now: () => new Date(NOW),
    });
    const response = await createMarketContextHandler(async () => result)();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
  });

  it("maps an unexpected service failure to a stable safe error", async () => {
    const response = await createMarketContextHandler(async () => {
      throw new Error("secret provider detail");
    })();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      code: "market_context_unavailable",
      error: "Market context is temporarily unavailable.",
    });
    expect(JSON.stringify(body)).not.toContain("secret provider detail");
  });
});

