import { describe, expect, it, vi } from "vitest";
import {
  AlpacaAssetCatalogProvider,
  AlpacaAssetProviderError,
} from "@/lib/providers/alpaca-assets";

function upstreamAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-nvda",
    class: "us_equity",
    exchange: "NASDAQ",
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    status: "active",
    tradable: true,
    marginable: true,
    shortable: true,
    fractionable: true,
    borrow_status: "easy_to_borrow",
    attributes: ["has_options"],
    ...overrides,
  };
}

describe("Alpaca active US-equity catalog provider", () => {
  it("uses the allowlisted Trading API with only documented catalog filters", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json([
        upstreamAsset(),
        upstreamAsset({ id: "inactive", symbol: "OLD", status: "inactive" }),
        upstreamAsset({ id: "crypto", symbol: "BTCUSD", class: "crypto" }),
      ]),
    );
    const provider = new AlpacaAssetCatalogProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      baseUrl: "https://api.alpaca.markets",
      fetcher,
    });

    await expect(provider.listActiveUsEquities()).resolves.toEqual([
      expect.objectContaining({
        id: "asset-nvda",
        symbolId: "NASDAQ:NVDA",
        symbol: "NVDA",
        exchange: "NASDAQ",
        status: "active",
        assetClass: "us_equity",
        tradable: true,
        attributes: ["has_options"],
      }),
    ]);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
    );
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("page_token")).toBe(false);
    const headers = new Headers(init.headers);
    expect(headers.get("APCA-API-KEY-ID")).toBe("test-key");
    expect(headers.get("APCA-API-SECRET-KEY")).toBe("test-secret");
    expect(url.toString()).not.toContain("test-secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses missing credentials and non-Alpaca hosts before fetch", async () => {
    const fetcher = vi.fn();
    const missingCredentials = new AlpacaAssetCatalogProvider({ fetcher });
    const untrustedHost = new AlpacaAssetCatalogProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      baseUrl: "https://api.alpaca.markets.attacker.example",
      fetcher,
    });

    await expect(missingCredentials.listActiveUsEquities()).rejects.toMatchObject({
      code: "provider_unconfigured",
    });
    await expect(untrustedHost.listActiveUsEquities()).rejects.toMatchObject({
      code: "provider_unconfigured",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves an exact identifier safely and treats absent or unsupported assets as missing", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(upstreamAsset({ symbol: "BRK.B" })))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(upstreamAsset({ class: "crypto", symbol: "BTCUSD" })),
      );
    const provider = new AlpacaAssetCatalogProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      fetcher,
    });

    await expect(provider.resolveExact("BRK/B")).resolves.toMatchObject({
      symbol: "BRK.B",
      assetClass: "us_equity",
    });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://paper-api.alpaca.markets/v2/assets/BRK%2FB",
    );
    await expect(provider.resolveExact("UNKNOWN")).resolves.toBeNull();
    await expect(provider.resolveExact("BTCUSD")).resolves.toBeNull();
  });

  it("maps rate limits and authentication failures to sanitized errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("do-not-return-this-body", {
          status: 429,
          headers: { "Retry-After": "12" },
        }),
      )
      .mockResolvedValueOnce(new Response("secret details", { status: 401 }));
    const provider = new AlpacaAssetCatalogProvider({
      keyId: "private-key-id",
      secretKey: "private-secret",
      fetcher,
    });

    const rateLimitError = await provider.listActiveUsEquities().catch((error) => error);
    expect(rateLimitError).toBeInstanceOf(AlpacaAssetProviderError);
    expect(rateLimitError).toMatchObject({
      code: "provider_rate_limited",
      status: 429,
      retryAfterSeconds: 12,
    });

    const authError = await provider.listActiveUsEquities().catch((error) => error);
    expect(authError).toMatchObject({ code: "provider_auth_failed", status: 401 });
    const messages = `${String(rateLimitError)} ${String(authError)}`;
    expect(messages).not.toContain("private-key-id");
    expect(messages).not.toContain("private-secret");
    expect(messages).not.toContain("do-not-return-this-body");
    expect(messages).not.toContain("secret details");
  });

  it("rejects malformed successful payloads instead of inventing assets", async () => {
    const provider = new AlpacaAssetCatalogProvider({
      keyId: "test-key",
      secretKey: "test-secret",
      fetcher: vi.fn().mockResolvedValue(Response.json({ assets: [] })),
    });

    await expect(provider.listActiveUsEquities()).rejects.toMatchObject({
      code: "provider_invalid_response",
    });
  });
});
