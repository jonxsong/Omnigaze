/**
 * Small, reviewed bootstrap catalog for the default Omnigaze watchlist.
 *
 * Arbitrary request-time symbols still resolve through the official SEC
 * ticker catalog. Durable ingestion deliberately requires an explicit,
 * stable CIK mapping so a persisted partition cannot silently switch issuers
 * between continuation pages.
 */
export const SEC_KNOWN_CIK_BY_TICKER: Readonly<Record<string, string>> = {
  AAPL: "320193",
  AMD: "2488",
  MSFT: "789019",
  NVDA: "1045810",
  TSLA: "1318605",
};
