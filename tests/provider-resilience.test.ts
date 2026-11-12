import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaProvider } from "@/lib/providers/alpaca";
import { ProviderConfigurationError } from "@/lib/providers/contracts";
import { SecEdgarProvider } from "@/lib/providers/sec-edgar";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("market provider resilience", () => {
  it("reports missing Alpaca credentials without attempting a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({});

    await expect(provider.getHealth()).resolves.toMatchObject({
      provider: "alpaca",
      status: "unconfigured",
      latestObservedAt: null,
    });
    await expect(provider.getSnapshot("NASDAQ:NVDA")).rejects.toBeInstanceOf(
      ProviderConfigurationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns explicit freshness and market-coverage metadata for an IEX snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        latestTrade: { p: 201.25, t: "2026-11-11T18:42:03.000Z" },
        dailyBar: { c: 201.1, v: 42_000_000 },
        prevDailyBar: { c: 198.5 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
      feed: "iex",
    });

    await expect(provider.getSnapshot("NASDAQ:NVDA")).resolves.toMatchObject({
      symbolId: "NASDAQ:NVDA",
      asOf: "2026-11-11T18:42:03.000Z",
      price: 201.25,
      previousClose: 198.5,
      volume: 42_000_000,
      isDelayed: false,
      delaySeconds: 0,
      provider: "Alpaca iex",
      marketCoverage: "limited-exchange",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed on an upstream Alpaca error without putting credentials in the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("provider unavailable", { status: 503 })),
    );
    const provider = new AlpacaProvider({
      keyId: "public-test-id",
      secretKey: "do-not-leak-this-secret",
    });

    let message = "";
    try {
      await provider.getSnapshot("NASDAQ:MSFT");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("503");
    expect(message).not.toContain("public-test-id");
    expect(message).not.toContain("do-not-leak-this-secret");
  });
});

describe("SEC EDGAR provider degradation", () => {
  it("reports a missing user agent as unconfigured", async () => {
    const provider = new SecEdgarProvider({
      cikByTicker: { NVDA: "1045810" },
    });

    await expect(provider.getHealth()).resolves.toMatchObject({
      provider: "sec-edgar",
      status: "unconfigured",
      latestObservedAt: null,
    });
    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC_USER_AGENT");
  });

  it("does not call EDGAR for a symbol without a configured CIK", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SecEdgarProvider({
      userAgent: "Omnigaze test@example.com",
      cikByTicker: {},
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an upstream EDGAR outage as a bounded provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("temporarily unavailable", { status: 503 })),
    );
    const provider = new SecEdgarProvider({
      userAgent: "Omnigaze test@example.com",
      cikByTicker: { NVDA: "1045810" },
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC submissions failed with 503");
  });
});
