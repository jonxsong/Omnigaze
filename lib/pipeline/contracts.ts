import type {
  CanonicalSymbol,
  EvidenceClassification,
  Materiality,
} from "@/lib/market-types";

export type SourceKind =
  | "market_quote"
  | "market_trade"
  | "sec_filing"
  | "company_release"
  | "licensed_news"
  | "macro_series";

export interface RawSourceEvent {
  source: string;
  sourceKind: SourceKind;
  sourceEventId: string;
  receivedAt: string;
  publishedAt: string;
  payload: unknown;
}

export interface NormalizedSourceEvent {
  id: string;
  canonicalSymbol: CanonicalSymbol | null;
  source: string;
  sourceKind: SourceKind;
  sourceEventId: string;
  receivedAt: string;
  publishedAt: string;
  classification: EvidenceClassification;
  materiality: Materiality | null;
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  rawPayloadHash: string;
}

export interface ProviderHealth {
  provider: string;
  status: "healthy" | "degraded" | "unconfigured";
  checkedAt: string;
  latestObservedAt: string | null;
  message?: string;
}

export interface IngestionResult {
  received: number;
  normalized: number;
  deduplicated: number;
  rejected: number;
  newestPublishedAt: string | null;
}
