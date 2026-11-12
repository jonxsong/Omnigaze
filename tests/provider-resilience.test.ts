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
import type { CanonicalSymbol } from "@/lib/market-types";

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

type SecTestFiling = {
  accessionNumber: string;
  filingDate: string;
  acceptanceDateTime: string;
  form: string;
  primaryDocument: string;
};

const SEC_USER_AGENT = "Omnigaze tests test@example.com";

function secSubmissions(rows: SecTestFiling[] = []) {
  return {
    filings: {
      recent: {
        accessionNumber: rows.map((row) => row.accessionNumber),
        filingDate: rows.map((row) => row.filingDate),
        acceptanceDateTime: rows.map((row) => row.acceptanceDateTime),
        form: rows.map((row) => row.form),
        primaryDocument: rows.map((row) => row.primaryDocument),
      },
    },
  };
}

function secFiling(
  accessionNumber: string,
  acceptanceDateTime: string,
): SecTestFiling {
  return {
    accessionNumber,
    filingDate: acceptanceDateTime.slice(0, 10),
    acceptanceDateTime,
    form: "8-K",
    primaryDocument: "report.htm",
  };
}

describe("SEC EDGAR provider activation readiness", () => {
  it("fails closed before fetching when the integration gate is disabled", async () => {
    const fetchMock = vi.fn();
    const provider = new SecEdgarProvider({
      enabled: false,
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      fetcher: fetchMock,
    });

    await expect(provider.getHealth()).resolves.toMatchObject({
      provider: "sec-edgar",
      status: "unconfigured",
      message: "SEC requests are disabled pending a distributed Fair Access coordinator.",
    });
    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow(
      "SEC requests are disabled pending a distributed Fair Access coordinator.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing or non-contact user agent as unconfigured without fetching", async () => {
    const fetchMock = vi.fn();
    const provider = new SecEdgarProvider({
      userAgent: "Omnigaze",
      cikByTicker: { NVDA: "1045810" },
      fetcher: fetchMock,
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
    expect(fetchMock).not.toHaveBeenCalled();
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
      userAgent: SEC_USER_AGENT,
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

  it("normalizes class-share aliases, preserves canonical symbols, and fetches once per CIK", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("company_tickers.json")
        ? Response.json({
            0: { cik_str: 1067983, ticker: "BRK-A", title: "Berkshire Hathaway" },
            1: { cik_str: 1067983, ticker: "BRK-B", title: "Berkshire Hathaway" },
          })
        : Response.json(
            secSubmissions([
              secFiling("0001067983-26-000001", "2026-11-11T18:30:00.000Z"),
            ]),
          ),
    );
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: {},
      fetcher: fetchMock,
      now: () => Date.parse("2026-11-12T00:00:00.000Z"),
    });

    const result = await provider.getLatestEvents({
      symbols: ["NYSE:BRK.B", "NYSE:BRK-A"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      expect.objectContaining({
        sourceEventId: "0001067983-26-000001",
        payload: expect.objectContaining({
          cik: "1067983",
          symbols: ["NYSE:BRK-A", "NYSE:BRK.B"],
        }),
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("CIK0001067983.json"),
      ),
    ).toHaveLength(1);
  });

  it("keeps colliding separator aliases on their exact, distinct CIKs", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return Response.json(secSubmissions());
    });
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { "ACME.B": "1", "ACME-B": "2" },
      fetcher: fetchMock,
    });

    await provider.getLatestEvents({
      symbols: ["NYSE:ACME.B", "NYSE:ACME-B"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });

    expect(requestedUrls.sort()).toEqual([
      "https://data.sec.gov/submissions/CIK0000000001.json",
      "https://data.sec.gov/submissions/CIK0000000002.json",
    ]);
  });

  it("consults the official exact ticker before accepting a configured separator alias", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      return url.includes("company_tickers.json")
        ? Response.json({
            0: { cik_str: 2, ticker: "ACME-B", title: "Exact official issuer" },
          })
        : Response.json(secSubmissions());
    });
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { "ACME.B": "1" },
      fetcher: fetchMock,
    });

    await provider.getLatestEvents({
      symbols: ["NYSE:ACME-B"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });

    expect(requestedUrls).toEqual([
      "https://www.sec.gov/files/company_tickers.json",
      "https://data.sec.gov/submissions/CIK0000000002.json",
    ]);
    expect(requestedUrls).not.toContain(
      "https://data.sec.gov/submissions/CIK0000000001.json",
    );
  });

  it("deduplicates accessions globally, sorts by newest update, then applies one limit", async () => {
    const sharedAccession = "0000000001-26-000001";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("CIK0000000001")) {
        return Response.json(
          secSubmissions([
            secFiling(sharedAccession, "2026-11-11T18:00:00.000Z"),
            secFiling("0000000001-26-000002", "2026-11-11T19:00:00.000Z"),
          ]),
        );
      }
      return Response.json(
        secSubmissions([
          secFiling(sharedAccession, "2026-11-11T20:00:00.000Z"),
          secFiling("0000000002-26-000002", "2026-11-11T21:00:00.000Z"),
        ]),
      );
    });
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { AAA: "1", BBB: "2" },
      fetcher: fetchMock,
    });

    const result = await provider.getLatestEvents({
      symbols: ["NYSE:AAA", "NYSE:BBB"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 2,
    });

    expect(Array.isArray(result) && result.map((event) => event.sourceEventId)).toEqual([
      "0000000002-26-000002",
      sharedAccession,
    ]);
    expect(Array.isArray(result) && result[1]?.payload).toEqual(
      expect.objectContaining({
        acceptedAt: "2026-11-11T20:00:00.000Z",
        symbols: ["NYSE:AAA", "NYSE:BBB"],
      }),
    );
  });

  it("singleflights submissions and reuses only the short-lived per-CIK cache", async () => {
    let clock = Date.parse("2026-11-12T00:00:00.000Z");
    const fetchMock = vi.fn(async () =>
      Response.json(
        secSubmissions([
          secFiling("0001045810-26-000001", "2026-11-11T18:30:00.000Z"),
        ]),
      ),
    );
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      fetcher: fetchMock,
      now: () => clock,
    });
    const request = () =>
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      });

    await Promise.all([request(), request()]);
    await request();
    expect(fetchMock).toHaveBeenCalledOnce();

    clock += 60_001;
    await request();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the per-CIK submissions cache and evicts its oldest entry", async () => {
    let clock = 0;
    const tickers = Array.from({ length: 33 }, (_, index) =>
      `T${String(index).padStart(2, "0")}`,
    );
    const fetchMock = vi.fn(async () => Response.json(secSubmissions()));
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: Object.fromEntries(
        tickers.map((ticker, index) => [ticker, String(index + 1)]),
      ),
      fetcher: fetchMock,
      now: () => clock,
    });

    for (const ticker of tickers) {
      await provider.getLatestEvents({
        symbols: [`NYSE:${ticker}`],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      });
      clock += 1_001;
    }
    expect(fetchMock).toHaveBeenCalledTimes(33);

    await provider.getLatestEvents({
      symbols: ["NYSE:T00"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });
    await provider.getLatestEvents({
      symbols: ["NYSE:T32"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });
    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it("shares a conservative FIFO request gate across concurrent provider calls", async () => {
    let clock = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const tickers = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
    const cikByTicker = Object.fromEntries(
      tickers.map((ticker, index) => [ticker, String(index + 1)]),
    );
    const fetchMock = vi.fn(async () => {
      starts.push(clock);
      return Response.json(secSubmissions());
    });
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker,
      fetcher: fetchMock,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
    const symbols = tickers.map((ticker) => `NYSE:${ticker}` as CanonicalSymbol);

    await Promise.all([
      provider.getLatestEvents({
        symbols: symbols.slice(0, 5),
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
      provider.getLatestEvents({
        symbols: symbols.slice(5),
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ]);

    expect(starts).toHaveLength(10);
    expect(starts.filter((startedAt) => startedAt < 1_000).length).toBeLessThanOrEqual(8);
    expect(starts.every((startedAt) => startedAt === 0 || startedAt === 1_000)).toBe(
      true,
    );
    expect(sleeps).toEqual([1_000]);
  });

  it("retains successful CIKs and explicitly marks a mixed batch partial", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("CIK0000000001")
        ? Response.json(
            secSubmissions([
              secFiling("0000000001-26-000001", "2026-11-11T18:30:00.000Z"),
            ]),
          )
        : new Response(null, { status: 503 }),
    );
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { AAA: "1", BBB: "2" },
      fetcher: fetchMock,
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NYSE:AAA", "NYSE:BBB"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      coverage: "partial",
      events: [expect.objectContaining({ sourceEventId: "0000000001-26-000001" })],
    });
  });

  it("bounds raw catalog properties before filtering malformed entries", async () => {
    const oversizedCatalog = Object.fromEntries(
      Array.from({ length: 25_001 }, (_, index) => [String(index), {}]),
    );
    const fetchMock = vi.fn().mockResolvedValue(Response.json(oversizedCatalog));
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: {},
      fetcher: fetchMock,
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NYSE:IBM"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC ticker catalog exceeded its bounded size.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an oversized advertised catalog body before reading it", async () => {
    const response = new Response("{}", {
      headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: {},
      fetcher: fetchMock,
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NYSE:IBM"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC ticker catalog exceeded its bounded response size.");
    expect(response.bodyUsed).toBe(false);
  });

  it("stops reading a streamed submissions body at the byte limit", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 9) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      fetcher: vi.fn().mockResolvedValue(new Response(body)),
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC submissions exceeded its bounded response size.");
    expect(emitted).toBe(9);
  });

  it.each([
    {
      name: "misaligned recent arrays",
      payload: {
        filings: {
          recent: {
            accessionNumber: ["0001045810-26-000001"],
            filingDate: [],
            acceptanceDateTime: ["2026-11-11T18:30:00.000Z"],
            form: ["8-K"],
            primaryDocument: ["report.htm"],
          },
        },
      },
    },
    {
      name: "invalid calendar and acceptance dates",
      payload: secSubmissions([
        {
          ...secFiling("0001045810-26-000001", "not-a-date"),
          filingDate: "2026-99-99",
        },
      ]),
    },
    {
      name: "date-parsable but non-canonical acceptance timestamps",
      payload: secSubmissions([
        secFiling("0001045810-26-000001", "2026-11-11 18:30:00"),
      ]),
    },
    {
      name: "oversized recent arrays",
      payload: secSubmissions(
        Array.from({ length: 2_001 }, (_, index) =>
          secFiling(
            `0001045810-26-${String(index).padStart(6, "0")}`,
            "2026-11-11T18:30:00.000Z",
          ),
        ),
      ),
    },
  ])("rejects $name with a stable bounded-response error", async ({ payload }) => {
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      fetcher: vi.fn().mockResolvedValue(Response.json(payload)),
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC submissions returned an invalid response.");
  });

  it("rejects acceptance timestamps beyond the documented clock-skew allowance", async () => {
    const now = Date.parse("2026-11-12T00:00:00.000Z");
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      now: () => now,
      fetcher: vi.fn().mockResolvedValue(
        Response.json(
          secSubmissions([
            secFiling("0001045810-26-000001", "2026-11-12T00:05:00.001Z"),
          ]),
        ),
      ),
    });

    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC submissions returned an invalid response.");
  });

  it("rejects oversized or malformed requests before network access", async () => {
    const fetchMock = vi.fn();
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
      cikByTicker: { NVDA: "1045810" },
      fetcher: fetchMock,
    });
    const oversized = Array.from(
      { length: 101 },
      () => "NASDAQ:NVDA" as CanonicalSymbol,
    );

    await expect(
      provider.getLatestEvents({
        symbols: oversized,
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC provider request is invalid.");
    await expect(
      provider.getLatestEvents({
        symbols: ["not-canonical" as CanonicalSymbol],
        since: "2026-11-01T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow("SEC provider request is invalid.");
    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "not-a-date",
        limit: 101,
      }),
    ).rejects.toThrow("SEC provider request is invalid.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an upstream EDGAR outage as a bounded provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("temporarily unavailable", { status: 503 })),
    );
    const provider = new SecEdgarProvider({
      userAgent: SEC_USER_AGENT,
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
