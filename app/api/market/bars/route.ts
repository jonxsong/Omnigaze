import type { CanonicalSymbol, HistoricalMarketSeries } from "@/lib/market-types";
import { instrumentApiRoute } from "@/lib/api-telemetry";
import { AlpacaProvider } from "@/lib/providers/alpaca";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";

export const dynamic = "force-dynamic";

type Range = HistoricalMarketSeries["timeframe"];

const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const ranges: Record<
  Range,
  { providerTimeframe: string; lookbackMs: number; limit: number }
> = {
  "1D": { providerTimeframe: "5Min", lookbackMs: 36 * 60 * 60 * 1_000, limit: 500 },
  "1W": { providerTimeframe: "30Min", lookbackMs: 8 * 24 * 60 * 60 * 1_000, limit: 500 },
  "1M": { providerTimeframe: "2Hour", lookbackMs: 32 * 24 * 60 * 60 * 1_000, limit: 500 },
  "3M": { providerTimeframe: "1Day", lookbackMs: 95 * 24 * 60 * 60 * 1_000, limit: 200 },
  "1Y": { providerTimeframe: "1Day", lookbackMs: 370 * 24 * 60 * 60 * 1_000, limit: 500 },
};

function noStoreJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function getMarketBars(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol")?.trim().toUpperCase();
  const requestedRange = params.get("timeframe")?.trim().toUpperCase() ?? "1D";

  if (!symbol || !canonicalSymbolPattern.test(symbol)) {
    return noStoreJson(
      {
        code: "invalid_symbol",
        error: "A canonical symbol such as NASDAQ:NVDA is required.",
      },
      400,
    );
  }
  if (!(requestedRange in ranges)) {
    return noStoreJson(
      {
        code: "invalid_timeframe",
        error: "Timeframe must be one of 1D, 1W, 1M, 3M, or 1Y.",
      },
      400,
    );
  }

  let verifiedSymbol: CanonicalSymbol;
  try {
    verifiedSymbol = (await resolveCanonicalInstrument(symbol as CanonicalSymbol)).id;
  } catch (error) {
    if (error instanceof InstrumentResolutionError) {
      return error.code === "symbol_not_supported"
        ? noStoreJson(
            { code: "symbol_not_supported", error: "Symbol is not supported." },
            422,
          )
        : noStoreJson(
            {
              code: "asset_catalog_unavailable",
              error: "The asset catalog is temporarily unavailable.",
            },
            503,
          );
    }
    return noStoreJson(
      { code: "symbol_resolution_failed", error: "Symbol could not be verified." },
      503,
    );
  }

  const range = requestedRange as Range;
  const config = ranges[range];
  const feed =
    process.env.ALPACA_DATA_FEED === "sip" ||
    process.env.ALPACA_DATA_FEED === "delayed_sip"
      ? process.env.ALPACA_DATA_FEED
      : "iex";
  const provider = new AlpacaProvider({
    keyId: process.env.ALPACA_API_KEY_ID,
    secretKey: process.env.ALPACA_API_SECRET_KEY,
    feed,
  });
  const now = new Date();
  const end = new Date(
    feed === "delayed_sip" ? now.getTime() - 15 * 60 * 1_000 : now.getTime(),
  );
  const start = new Date(end.getTime() - config.lookbackMs);

  try {
    const data = await provider.getHistoricalBars(verifiedSymbol, {
      range,
      timeframe: config.providerTimeframe,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: config.limit,
    });
    if (data.symbolId !== verifiedSymbol) {
      return noStoreJson(
        {
          code: "historical_data_unavailable",
          error: "Historical market data is temporarily unavailable.",
        },
        503,
      );
    }
    return noStoreJson({
      data,
      meta: {
        dataMode: "live",
        freshness: {
          state: data.asOf ? "fresh" : "unknown",
          asOf: data.asOf,
        },
        notice:
          "Provider history adjusted for corporate actions. Coverage depends on the configured market-data feed.",
      },
    });
  } catch (error) {
    const unconfigured =
      error instanceof Error && error.name === "ProviderConfigurationError";
    return noStoreJson(
      {
        code: unconfigured ? "provider_unconfigured" : "historical_data_unavailable",
        error: unconfigured
          ? "Historical market data is not configured."
          : "Historical market data is temporarily unavailable.",
      },
      503,
    );
  }
}

export const GET = instrumentApiRoute(
  { operation: "api.market.bars.get", slowMs: 5_000 },
  getMarketBars,
);
