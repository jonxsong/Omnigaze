import { z } from "zod";
import {
  MARKET_CONTEXT_NOTICE,
  marketContextProxies,
  type MarketContextResult,
} from "@/lib/market-context";

const canonicalSymbolSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .max(64);
const timestampSchema = z.string().datetime({ offset: true });
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value));

const proxyFields = {
  key: z.enum([
    "us-large-cap",
    "us-growth",
    "us-small-cap",
    "long-treasury",
    "oil",
    "gold",
  ]),
  symbolId: canonicalSymbolSchema,
  ticker: z.string().regex(/^[A-Z0-9._-]{1,20}$/),
  label: safeTextSchema,
  assetType: z.literal("etf_proxy"),
} as const;

const snapshotSchema = z
  .object({
    symbolId: canonicalSymbolSchema,
    asOf: timestampSchema,
    session: z.enum(["pre-market", "regular", "after-hours", "closed"]),
    price: z.number().finite().positive(),
    previousClose: z.number().finite().positive(),
    change: z.number().finite(),
    changePercent: z.number().finite(),
    volume: z.number().int().nonnegative(),
    isDelayed: z.boolean(),
    delaySeconds: z.number().int().nonnegative(),
    provider: safeTextSchema.max(64),
    marketCoverage: z.enum(["limited-exchange", "consolidated"]),
  })
  .strict();

const liveItemSchema = z
  .object({
    ...proxyFields,
    status: z.enum(["live", "stale"]),
    snapshot: snapshotSchema,
  })
  .strict();
const demoItemSchema = z
  .object({
    ...proxyFields,
    status: z.literal("demo"),
    reason: z.literal("demo_suppressed"),
  })
  .strict();
const unavailableItemSchema = z
  .object({
    ...proxyFields,
    status: z.literal("unavailable"),
    reason: z.enum([
      "snapshot_unavailable",
      "identity_mismatch",
      "invalid_provider_response",
      "freshness_unverified",
      "provider_unavailable",
    ]),
  })
  .strict();

const marketContextEnvelopeSchema = z
  .object({
    data: z
      .array(z.union([liveItemSchema, demoItemSchema, unavailableItemSchema]))
      .length(marketContextProxies.length),
    meta: z
      .object({
        status: z.enum(["live", "partial", "stale", "demo", "unavailable"]),
        requestedCount: z.number().int().nonnegative(),
        liveCount: z.number().int().nonnegative(),
        staleCount: z.number().int().nonnegative(),
        demoCount: z.number().int().nonnegative(),
        unavailableCount: z.number().int().nonnegative(),
        availabilityCoverage: z.enum(["complete", "partial", "none"]),
        marketCoverage: z.enum(["complete", "partial", "none"]),
        generatedAt: timestampSchema,
        notice: z.literal(MARKET_CONTEXT_NOTICE),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    envelope.data.forEach((item, index) => {
      const proxy = marketContextProxies[index];
      if (
        item.key !== proxy.key ||
        item.symbolId !== proxy.symbolId ||
        item.ticker !== proxy.ticker ||
        item.label !== proxy.label ||
        item.assetType !== proxy.assetType
      ) {
        context.addIssue({
          code: "custom",
          path: ["data", index],
          message: "Market context proxy identity or order is invalid.",
        });
      }
      if (
        (item.status === "live" || item.status === "stale") &&
        item.snapshot.symbolId !== item.symbolId
      ) {
        context.addIssue({
          code: "custom",
          path: ["data", index, "snapshot", "symbolId"],
          message: "Snapshot identity does not match its ETF proxy.",
        });
      }
    });

    const liveCount = envelope.data.filter((item) => item.status === "live").length;
    const staleCount = envelope.data.filter((item) => item.status === "stale").length;
    const demoCount = envelope.data.filter((item) => item.status === "demo").length;
    const unavailableCount =
      envelope.data.length - liveCount - staleCount - demoCount;
    const available = liveCount + staleCount;
    const expectedStatus =
      liveCount === envelope.data.length
        ? "live"
        : liveCount > 0
          ? "partial"
          : staleCount > 0
            ? "stale"
            : demoCount > 0
              ? "demo"
              : "unavailable";
    const expectedAvailability =
      available === envelope.data.length
        ? "complete"
        : available > 0
          ? "partial"
          : "none";
    const snapshots = envelope.data.flatMap((item) =>
      item.status === "live" || item.status === "stale" ? [item.snapshot] : [],
    );
    const expectedMarketCoverage =
      snapshots.length === 0
        ? "none"
        : snapshots.every((snapshot) => snapshot.marketCoverage === "consolidated")
          ? "complete"
          : "partial";

    const expectedMeta = {
      requestedCount: envelope.data.length,
      liveCount,
      staleCount,
      demoCount,
      unavailableCount,
      availabilityCoverage: expectedAvailability,
      marketCoverage: expectedMarketCoverage,
      status: expectedStatus,
    };
    for (const [field, value] of Object.entries(expectedMeta)) {
      if (envelope.meta[field as keyof typeof expectedMeta] !== value) {
        context.addIssue({
          code: "custom",
          path: ["meta", field],
          message: "Market context summary does not match its items.",
        });
      }
    }
  });

export function parseMarketContextEnvelope(value: unknown): MarketContextResult {
  return marketContextEnvelopeSchema.parse(value) as MarketContextResult;
}

