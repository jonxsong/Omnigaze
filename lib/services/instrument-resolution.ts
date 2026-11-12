import { workspaceBySymbol } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";
import { AlpacaAssetProviderError } from "@/lib/providers/alpaca-assets";
import { getAssetSearchService } from "@/lib/services/asset-search";

export interface ResolvedInstrument {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
  sector: string | null;
  currency: "USD";
  status: "active";
}

export type InstrumentResolutionErrorCode =
  | "symbol_not_supported"
  | "asset_catalog_unavailable";

export class InstrumentResolutionError extends Error {
  constructor(readonly code: InstrumentResolutionErrorCode) {
    super(code);
    this.name = "InstrumentResolutionError";
  }
}

type ExactAssetResolver = Pick<
  ReturnType<typeof getAssetSearchService>,
  "resolveExact"
>;

function splitCanonicalSymbol(symbolId: CanonicalSymbol) {
  const separator = symbolId.indexOf(":");
  return {
    exchange: symbolId.slice(0, separator),
    ticker: symbolId.slice(separator + 1),
  };
}

export async function resolveCanonicalInstrument(
  symbolId: CanonicalSymbol,
  resolver: ExactAssetResolver = getAssetSearchService(),
): Promise<ResolvedInstrument> {
  const fixture = workspaceBySymbol.get(symbolId);
  if (fixture) {
    return {
      id: fixture.instrument.id,
      ticker: fixture.instrument.ticker,
      exchange: fixture.instrument.exchange,
      name: fixture.instrument.name,
      sector: fixture.instrument.sector,
      currency: "USD",
      status: "active",
    };
  }

  const { exchange, ticker } = splitCanonicalSymbol(symbolId);
  let asset;
  try {
    asset = await resolver.resolveExact(ticker);
  } catch (error) {
    if (error instanceof AlpacaAssetProviderError) {
      throw new InstrumentResolutionError("asset_catalog_unavailable");
    }
    throw new InstrumentResolutionError("asset_catalog_unavailable");
  }

  if (
    !asset ||
    asset.symbol !== ticker ||
    asset.exchange !== exchange ||
    asset.symbolId !== symbolId
  ) {
    throw new InstrumentResolutionError("symbol_not_supported");
  }

  return {
    id: asset.symbolId,
    ticker: asset.symbol,
    exchange: asset.exchange,
    name: asset.name,
    sector: null,
    currency: "USD",
    status: "active",
  };
}
