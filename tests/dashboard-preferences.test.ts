import { describe, expect, it } from "vitest";
import { parseDashboardPreferences } from "@/components/market-dashboard";

describe("dashboard preference migration", () => {
  it("migrates v1 demo-symbol preferences into the v2 instrument shape", () => {
    const preferences = parseDashboardPreferences(
      JSON.stringify({
        version: 1,
        watchlist: ["NASDAQ:MSFT", "NASDAQ:NVDA", "NYSE:NOT-IN-FIXTURES"],
        selectedSymbol: "NASDAQ:MSFT",
        timeframe: "1M",
      }),
    );

    expect(preferences).toMatchObject({
      version: 2,
      selectedSymbol: "NASDAQ:MSFT",
      timeframe: "1M",
      instruments: [
        {
          id: "NASDAQ:MSFT",
          ticker: "MSFT",
          exchange: "NASDAQ",
          name: "Microsoft Corporation",
          currency: "USD",
        },
        {
          id: "NASDAQ:NVDA",
          ticker: "NVDA",
          exchange: "NASDAQ",
          name: "NVIDIA Corporation",
          currency: "USD",
        },
      ],
    });
  });

  it("retains arbitrary v2 instrument metadata across reloads", () => {
    const preferences = parseDashboardPreferences(
      JSON.stringify({
        version: 2,
        instruments: [
          {
            id: "NYSE:IBM",
            ticker: "IBM",
            exchange: "NYSE",
            name: "International Business Machines Corporation",
            sector: null,
            currency: "USD",
          },
        ],
        selectedSymbol: "NYSE:IBM",
        timeframe: "1Y",
      }),
    );

    expect(preferences).toEqual({
      version: 2,
      instruments: [
        {
          id: "NYSE:IBM",
          ticker: "IBM",
          exchange: "NYSE",
          name: "International Business Machines Corporation",
          sector: null,
          currency: "USD",
        },
      ],
      selectedSymbol: "NYSE:IBM",
      timeframe: "1Y",
    });
  });

  it("drops malformed v2 metadata instead of reconstructing a different company", () => {
    const preferences = parseDashboardPreferences(
      JSON.stringify({
        version: 2,
        instruments: [
          {
            id: "NYSE:IBM",
            ticker: "NVDA",
            exchange: "NASDAQ",
            name: "Mismatched identity",
            currency: "USD",
          },
        ],
        selectedSymbol: "NYSE:IBM",
        timeframe: "not-a-timeframe",
      }),
    );

    expect(preferences).toMatchObject({
      version: 2,
      instruments: [],
      selectedSymbol: "NYSE:IBM",
      timeframe: "1D",
    });
  });
});
