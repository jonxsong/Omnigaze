import { describe, expect, it, vi } from "vitest";
import { createMoveLensHandler } from "@/app/api/market/move-lens/route";
import { buildMoveLens } from "@/lib/move-lens";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

const result = buildMoveLens({
  selectedSymbolId: "NASDAQ:NVDA",
  selectedSnapshot: undefined,
  benchmarkSnapshots: new Map(),
  evidence: [],
  evidenceReadStatus: "verified",
  evaluatedAt: "2026-11-12T18:00:00.000Z",
});

describe("Move Lens API", () => {
  it("uses the market API symbol query and returns the exact no-store envelope", async () => {
    const readMoveLens = vi.fn(async () => result);
    const response = await createMoveLensHandler(readMoveLens)(
      new Request(
        "https://omnigaze.test/api/market/move-lens?symbol=nasdaq%3Anvda",
      ),
    );

    expect(readMoveLens).toHaveBeenCalledWith("NASDAQ:NVDA");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
  });

  it.each([
    "https://omnigaze.test/api/market/move-lens",
    "https://omnigaze.test/api/market/move-lens?symbol=NVDA",
    "https://omnigaze.test/api/market/move-lens?symbol=NASDAQ%3ANVDA&extra=1",
    "https://omnigaze.test/api/market/move-lens?symbol=NASDAQ%3ANVDA&symbol=ARCA%3ASPY",
  ])("rejects malformed or non-closed query input: %s", async (url) => {
    const readMoveLens = vi.fn(async () => result);
    const response = await createMoveLensHandler(readMoveLens)(new Request(url));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "invalid_symbol",
      error: "A single canonical symbol such as NASDAQ:NVDA is required.",
    });
    expect(readMoveLens).not.toHaveBeenCalled();
  });

  it("maps unsupported symbols and catalog outages to stable safe errors", async () => {
    const unsupported = await createMoveLensHandler(async () => {
      throw new InstrumentResolutionError("symbol_not_supported");
    })(
      new Request(
        "https://omnigaze.test/api/market/move-lens?symbol=NASDAQ%3AFAKE",
      ),
    );
    const unavailable = await createMoveLensHandler(async () => {
      throw new InstrumentResolutionError("asset_catalog_unavailable");
    })(
      new Request(
        "https://omnigaze.test/api/market/move-lens?symbol=NASDAQ%3ANVDA",
      ),
    );

    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({
      code: "symbol_not_supported",
      error: "Symbol is not supported.",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      code: "asset_catalog_unavailable",
      error: "The asset catalog is temporarily unavailable.",
    });
  });

  it("never leaks an unexpected service failure", async () => {
    const response = await createMoveLensHandler(async () => {
      throw new Error("secret upstream token=credential");
    })(
      new Request(
        "https://omnigaze.test/api/market/move-lens?symbol=NASDAQ%3ANVDA",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      code: "move_lens_unavailable",
      error: "Move Lens is temporarily unavailable.",
    });
    expect(JSON.stringify(body)).not.toContain("credential");
  });
});
