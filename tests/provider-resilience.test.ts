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

  it("rejects snapshots without a provider timestamp instead of inventing freshness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          latestTrade: { p: 201.25 },
          dailyBar: { c: 201.1, v: 42_000_000 },
          prevDailyBar: { c: 198.5 },
        }),
      ),
    );
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
      feed: "iex",
    });

    await expect(provider.getSnapshot("NASDAQ:NVDA")).rejects.toThrow(
      "incomplete snapshot",
    );
  });

  it("preserves Alpaca's provider update timestamp for correction ordering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          news: [
            {
              id: 42,
              headline: "Provider correction",
              created_at: "2026-11-11T18:40:00.000Z",
              updated_at: "2026-11-11T18:44:00.000Z",
              symbols: ["NVDA"],
            },
          ],
        }),
      ),
    );
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-11T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceEventId: "42",
        publishedAt: "2026-11-11T18:40:00.000Z",
        providerUpdatedAt: "2026-11-11T18:44:00.000Z",
      }),
    ]);
  });

  it("paginates Alpaca news, filters defensively by symbol, and deduplicates article ids", async () => {
    const firstPageItem = {
      id: 41,
      headline: "First NVIDIA update",
      created_at: "2026-11-11T18:40:00.000Z",
      updated_at: "2026-11-11T18:41:00.000Z",
      symbols: ["NVDA"],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          news: [
            firstPageItem,
            {
              id: 900,
              headline: "Unrelated article",
              created_at: "2026-11-11T18:39:00.000Z",
              updated_at: "2026-11-11T18:39:00.000Z",
              symbols: ["AAPL"],
            },
          ],
          next_page_token: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          news: [
            firstPageItem,
            {
              id: 42,
              headline: "Second NVIDIA update",
              created_at: "2026-11-11T18:38:00.000Z",
              updated_at: "2026-11-11T18:38:30.000Z",
              symbols: ["nvda", "MSFT"],
            },
          ],
          next_page_token: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });

    const events = await provider.getLatestEvents({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 2,
    });

    expect(events.map((event) => event.sourceEventId)).toEqual(["41", "42"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstUrl.searchParams.get("symbols")).toBe("NVDA");
    expect(firstUrl.searchParams.get("limit")).toBe("2");
    expect(firstUrl.searchParams.has("page_token")).toBe(false);
    expect(secondUrl.searchParams.get("page_token")).toBe("page-2");
    expect(secondUrl.searchParams.get("limit")).toBe("1");
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(
      fetchMock.mock.calls[1][1]?.signal,
    );
  });

  it("fails closed when Alpaca repeats a pagination token", async () => {
    const article = {
      id: 41,
      headline: "NVIDIA update",
      created_at: "2026-11-11T18:40:00.000Z",
      updated_at: "2026-11-11T18:41:00.000Z",
      symbols: ["NVDA"],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ news: [article], next_page_token: "same-token" }),
      )
      .mockResolvedValueOnce(
        Response.json({ news: [article], next_page_token: "same-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-11T00:00:00.000Z",
        limit: 2,
      }),
    ).rejects.toThrow("repeated page token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination instead of silently reporting a truncated news window", async () => {
    const fetchMock = vi.fn();
    for (let page = 1; page <= 4; page += 1) {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          news: [
            {
              id: page,
              headline: `Unrelated article ${page}`,
              created_at: "2026-11-11T18:40:00.000Z",
              updated_at: "2026-11-11T18:41:00.000Z",
              symbols: ["AAPL"],
            },
          ],
          next_page_token: `page-${page + 1}`,
        }),
      );
    }
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-11T00:00:00.000Z",
        limit: 2,
      }),
    ).rejects.toThrow("bounded page limit");
    expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it("resolves an arbitrary ticker through the official SEC ticker catalog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          0: { cik_str: 51143, ticker: "IBM", title: "INTERNATIONAL BUSINESS MACHINES CORP" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          filings: {
            recent: {
              accessionNumber: ["0000051143-26-000001"],
              filingDate: ["2026-11-11"],
              acceptanceDateTime: ["2026-11-11T18:30:00.000Z"],
              form: ["8-K"],
              primaryDocument: ["ibm-8k.htm"],
            },
          },
        }),
      );
    const provider = new SecEdgarProvider({
      userAgent: "Omnigaze test@example.com",
      cikByTicker: {},
      fetcher: fetchMock,
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NYSE:IBM"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        source: "sec-edgar",
        sourceKind: "sec_filing",
        sourceEventId: "0000051143-26-000001",
        publishedAt: "2026-11-11T18:30:00.000Z",
        providerUpdatedAt: "2026-11-11T18:30:00.000Z",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://www.sec.gov/files/company_tickers.json",
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://data.sec.gov/submissions/CIK0000051143.json",
    );
  });

  it("surfaces an upstream EDGAR outage as a bounded provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("temporarily unavailable", { status: 503 })),
    );
    const provider = new SecEdgarProvider({
      userAgent: "Omnigaze test@example.com",
      cikByTicker: { NVDA: "1045810" },
      fetcher: fetch,
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
