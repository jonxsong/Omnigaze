export type CanonicalSymbol = `${string}:${string}`;

export type MarketSession =
  | "pre-market"
  | "regular"
  | "after-hours"
  | "closed";

export type EvidenceClassification = "fact" | "derived" | "inference";

export type Direction = "positive" | "negative" | "mixed" | "unclear";

export type Materiality = "low" | "medium" | "high" | "critical";

export type ClaimStatus =
  | "confirmed"
  | "official-investigation"
  | "reported"
  | "allegation"
  | "disputed"
  | "corrected";

export type CausalLink =
  | "unassessed"
  | "temporal-only"
  | "plausible-contributor"
  | "supported";

export interface Instrument {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
  sector: string;
  currency: string;
}

export interface MarketPoint {
  timestamp: string;
  label: string;
  price: number;
  volume: number;
}

export interface HistoricalBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number | null;
  volumeWeightedPrice: number | null;
}

export interface HistoricalMarketSeries {
  symbolId: CanonicalSymbol;
  timeframe: "1D" | "1W" | "1M" | "3M" | "1Y";
  asOf: string | null;
  provider: string;
  marketCoverage: "limited-exchange" | "consolidated";
  isDelayed: boolean;
  delaySeconds: number;
  adjustment: "all";
  bars: HistoricalBar[];
}

export interface MarketSnapshot {
  symbolId: CanonicalSymbol;
  asOf: string;
  session: MarketSession;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap: string;
  isDelayed: boolean;
  delaySeconds: number;
  provider: string;
  marketCoverage: "limited-exchange" | "consolidated" | "fixture";
}

export interface Evidence {
  id: string;
  classification: EvidenceClassification;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string | null;
  locator?: string;
  excerpt?: string;
}

export interface IntelligenceEvent {
  id: string;
  symbolId: CanonicalSymbol;
  headline: string;
  summary: string;
  occurredAt: string;
  materiality: Materiality;
  possibleDirection: Direction;
  status: "preliminary" | "verified" | "corrected";
  evidenceIds: string[];
  category:
    | "earnings"
    | "filing"
    | "macro"
    | "market"
    | "product"
    | "governance"
    | "executive"
    | "legal"
    | "regulatory"
    | "reputation"
    | "geopolitical";
  claimStatus?: ClaimStatus;
  causalLink?: CausalLink;
  topicTags?: string[];
  sourceCount?: number;
}

export interface ViewDriver {
  label: string;
  direction: Direction;
  explanation: string;
  evidenceIds: string[];
}

export interface OmnigazeView {
  symbolId: CanonicalSymbol;
  generatedAt: string;
  horizon: "intraday" | "near-term" | "long-term";
  stance: "bullish" | "bearish" | "mixed" | "neutral";
  confidence: number;
  summary: string;
  whyNow: string;
  drivers: ViewDriver[];
  unknowns: string[];
  dataCutoff: string;
  disclaimer: string;
}

export interface StockWorkspace {
  instrument: Instrument;
  snapshot: MarketSnapshot;
  chart: Record<"1D" | "1W" | "1M" | "3M" | "1Y", MarketPoint[]>;
  events: IntelligenceEvent[];
  evidence: Evidence[];
  view: OmnigazeView;
}
