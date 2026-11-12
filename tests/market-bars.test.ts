import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaProvider } from "@/lib/providers/alpaca";
import { GET as getBars } from "@/app/api/market/bars/route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("historical bars API", () => {
  it("rejects malformed symbols and timeframes before calling a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const symbolResponse = await getBars(
      new Request("https://omnigaze.test/api/market/bars?symbol=NVDA&timeframe=1D"),
    );
    const timeframeResponse = await getBars(
      new Request(
        "https://omnigaze.test/api/market/bars?symbol=NASDAQ:NVDA&timeframe=MAX",
      ),
    );

    expect(symbolResponse.status).toBe(400);
    expect(await symbolResponse.json()).toMatchObject({ code: "invalid_symbol" });
    expect(timeframeResponse.status).toBe(400);
    expect(await timeframeResponse.json()).toMatchObject({
      code: "invalid_timeframe",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns normalized live history without exposing credentials", async () => {
    vi.stubEnv("ALPACA_API_KEY_ID", "route-test-key");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "route-test-secret");
    vi.stubEnv("ALPACA_DATA_FEED", "iex");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          bars: [
            {
              t: "2026-11-12T17:00:00Z",
              o: 200,
              h: 202,
              l: 199,
              c: 201,
              v: 1_000,
            },
          ],
        }),
      ),
    );

    const response = await getBars(
      new Request(
        "https://omnigaze.test/api/market/bars?symbol=nasdaq:nvda&timeframe=1w",
      ),
    );
    const body = (await response.json()) as {
      data: { symbolId: string; timeframe: string; bars: unknown[] };
      meta: { dataMode: string };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      data: { symbolId: "NASDAQ:NVDA", timeframe: "1W" },
      meta: { dataMode: "live" },
    });
    expect(body.data.bars).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("route-test-secret");
  });

  it("fails closed when provider credentials are absent", async () => {
    vi.stubEnv("ALPACA_API_KEY_ID", "");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getBars(
      new Request(
        "https://omnigaze.test/api/market/bars?symbol=NASDAQ:NVDA&timeframe=1D",
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "provider_unconfigured",
      error: "Historical market data is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Alpaca historical bars", () => {
  it("normalizes, filters, and sorts provider bars with explicit coverage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        bars: [
          { t: "2026-11-12T16:05:00Z", o: 201, h: 203, l: 200, c: 202, v: 50, n: 4, vw: 201.7 },
          { t: "invalid", o: 1, h: 1, l: 1, c: 1, v: 1 },
          { t: "2026-11-12T16:00:00Z", o: 198, h: 202, l: 197, c: 201, v: 40 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "iex",
    });

    const result = await provider.getHistoricalBars("NASDAQ:NVDA", {
      range: "1D",
      timeframe: "5Min",
      start: "2026-11-12T00:00:00.000Z",
      end: "2026-11-12T18:00:00.000Z",
    });

    expect(result).toMatchObject({
      symbolId: "NASDAQ:NVDA",
      timeframe: "1D",
      asOf: "2026-11-12T16:05:00Z",
      provider: "Alpaca iex",
      marketCoverage: "limited-exchange",
      isDelayed: false,
      adjustment: "all",
    });
    expect(result.bars).toHaveLength(2);
    expect(result.bars[0]).toMatchObject({
      timestamp: "2026-11-12T16:00:00Z",
      close: 201,
      tradeCount: null,
    });

    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.searchParams.get("timeframe")).toBe("5Min");
    expect(requested.searchParams.get("adjustment")).toBe("all");
    expect(requested.searchParams.get("feed")).toBe("iex");
    expect(requested.searchParams.get("sort")).toBe("asc");
  });

  it("maps delayed SIP to the SIP historical feed while preserving delay metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ bars: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "delayed_sip",
    });

    const result = await provider.getHistoricalBars("NYSE:IBM", {
      range: "1M",
      timeframe: "2Hour",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      provider: "Alpaca delayed_sip",
      marketCoverage: "consolidated",
      isDelayed: true,
      delaySeconds: 900,
    });
    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.searchParams.get("feed")).toBe("sip");
  });

  it("sanitizes upstream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret details", { status: 429 })),
    );
    const provider = new AlpacaProvider({
      keyId: "public-key",
      secretKey: "never-leak",
    });

    await expect(
      provider.getHistoricalBars("NASDAQ:NVDA", {
        range: "1D",
        timeframe: "5Min",
        start: "2026-11-11T00:00:00.000Z",
        end: "2026-11-12T00:00:00.000Z",
      }),
    ).rejects.toThrow("Alpaca historical bars failed with 429");
  });
});
