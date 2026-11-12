import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlpacaProvider,
  createAlpacaNewsQueryFingerprint,
} from "@/lib/providers/alpaca";
import {
  ProviderConfigurationError,
  ProviderCursorMismatchError,
  ProviderCursorRejectedError,
} from "@/lib/providers/contracts";
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

  it("loads multiple quotes in one bounded request and isolates malformed peers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        NVDA: {
          latestTrade: { p: 201.25, t: "2026-11-11T18:42:03.000Z" },
          dailyBar: { c: 201.1, v: 42_000_000 },
          prevDailyBar: { c: 198.5 },
        },
        MSFT: {
          latestTrade: { p: 510.5 },
          dailyBar: { c: 509, v: 20_000_000 },
          prevDailyBar: { c: 505 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
      feed: "iex",
    });

    const snapshots = await provider.getSnapshots([
      "NASDAQ:NVDA",
      "NASDAQ:MSFT",
    ]);

    expect([...snapshots.keys()]).toEqual(["NASDAQ:NVDA"]);
    expect(snapshots.get("NASDAQ:NVDA")).toMatchObject({
      symbolId: "NASDAQ:NVDA",
      price: 201.25,
      provider: "Alpaca iex",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe("/v2/stocks/snapshots");
    expect(requestedUrl.searchParams.get("symbols")).toBe("NVDA,MSFT");
    expect(requestedUrl.searchParams.get("feed")).toBe("iex");
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

  it("fetches exactly one ascending Alpaca page inside a frozen window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        news: [
          {
            id: 42,
            headline: "Provider correction",
            created_at: "2026-11-11T18:40:00.000Z",
            updated_at: "2026-11-11T18:44:00.000Z",
            symbols: ["NVDA"],
          },
          {
            id: 900,
            headline: "Unrelated article",
            created_at: "2026-11-11T18:41:00.000Z",
            updated_at: "2026-11-11T18:41:00.000Z",
            symbols: ["TSLA"],
          },
        ],
        next_page_token: "page-2",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });

    const page = await provider.getEventPage({
      symbols: ["NASDAQ:MSFT", "NASDAQ:NVDA", "NASDAQ:NVDA"],
      windowStart: "2026-11-11T00:00:00Z",
      windowEnd: "2026-11-12T00:00:00Z",
      pageSize: 50,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("symbols")).toBe("MSFT,NVDA");
    expect(url.searchParams.get("start")).toBe("2026-11-11T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-11-12T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("asc");
    expect(url.searchParams.has("page_token")).toBe(false);
    expect(page.events.map((event) => event.sourceEventId)).toEqual(["42"]);
    expect(page.exhausted).toBe(false);
    expect(page.nextCursor).toEqual({
      token: "page-2",
      queryFingerprint: page.queryFingerprint,
    });
    expect(page.queryFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the page fingerprint stable and rejects a cross-query cursor before fetch", async () => {
    const first = await createAlpacaNewsQueryFingerprint({
      symbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      windowStart: "2026-11-11T00:00:00.000Z",
      windowEnd: "2026-11-12T00:00:00.000Z",
      pageSize: 25,
    });
    const reordered = await createAlpacaNewsQueryFingerprint({
      symbols: ["NASDAQ:MSFT", "NASDAQ:NVDA", "NASDAQ:MSFT"],
      windowStart: "2026-11-11T00:00:00Z",
      windowEnd: "2026-11-12T00:00:00Z",
      pageSize: 25,
    });
    expect(reordered).toBe(first);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });
    await expect(
      provider.getEventPage({
        symbols: ["NASDAQ:NVDA"],
        windowStart: "2026-11-11T00:00:00Z",
        windowEnd: "2026-11-12T00:00:00Z",
        pageSize: 25,
        cursor: { token: "opaque-token", queryFingerprint: first },
      }),
    ).rejects.toBeInstanceOf(ProviderCursorMismatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues a matching frozen query without traversing another page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ news: [], next_page_token: null })),
    );
    const fetchMock = vi.mocked(fetch);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });
    const queryFingerprint = await createAlpacaNewsQueryFingerprint({
      symbols: ["NASDAQ:NVDA"],
      windowStart: "2026-11-11T00:00:00Z",
      windowEnd: "2026-11-12T00:00:00Z",
      pageSize: 25,
    });

    await expect(
      provider.getEventPage({
        symbols: ["NASDAQ:NVDA"],
        windowStart: "2026-11-11T00:00:00Z",
        windowEnd: "2026-11-12T00:00:00Z",
        pageSize: 25,
        cursor: { token: "opaque-token", queryFingerprint },
      }),
    ).resolves.toMatchObject({ exhausted: true, nextCursor: null });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("page_token")).toBe("opaque-token");
  });

  it("classifies a rejected stored Alpaca token without exposing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AlpacaProvider({
      keyId: "test-key-id",
      secretKey: "test-secret-value",
    });
    const queryFingerprint = await createAlpacaNewsQueryFingerprint({
      symbols: ["NASDAQ:NVDA"],
      windowStart: "2026-11-11T00:00:00Z",
      windowEnd: "2026-11-12T00:00:00Z",
      pageSize: 25,
    });

    let error: unknown;
    try {
      await provider.getEventPage({
        symbols: ["NASDAQ:NVDA"],
        windowStart: "2026-11-11T00:00:00Z",
        windowEnd: "2026-11-12T00:00:00Z",
        pageSize: 25,
        cursor: {
          token: "sensitive-provider-token",
          queryFingerprint,
        },
      });
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(ProviderCursorRejectedError);
    expect(error instanceof Error ? error.message : String(error)).not.toContain(
      "sensitive-provider-token",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
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
