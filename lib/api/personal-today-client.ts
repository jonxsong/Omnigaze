import { z } from "zod";
import { isCredentialFreePublicHttpUrl } from "@/lib/security/public-http-url";

const canonicalSymbolSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .max(64);

const timestampSchema = z.string().datetime({ offset: true });

const safeSourceUrlSchema = z.preprocess((value) => {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const canonical = new URL(value).toString();
    return isCredentialFreePublicHttpUrl(canonical) ? canonical : null;
  } catch {
    return null;
  }
}, z.string().max(2_048).nullable());

const providerSchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    status: z.enum(["healthy", "degraded", "unconfigured"]),
    checkedAt: timestampSchema,
    latestObservedAt: timestampSchema.nullable(),
    message: z.string().trim().min(1).max(1_000).optional(),
    capabilities: z
      .array(z.enum(["market-snapshot", "market-news", "sec-filings"]))
      .max(8),
    attempted: z.boolean(),
  })
  .strict();

const readPlaneOriginSchema = z
  .object({
    status: z.enum(["live", "demo", "failed", "ready"]),
    candidateCount: z.number().int().nonnegative().max(10_000),
    selectedCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

const readPlaneSchema = z
  .object({
    strategy: z.literal("durable_plus_request_time"),
    requestTimeFailed: z.boolean(),
    collectedReadFailed: z.boolean(),
    collectedTruncated: z.boolean(),
    origins: z
      .object({
        requestTime: readPlaneOriginSchema.extend({
          status: z.enum(["live", "demo", "failed"]),
        }),
        durable: readPlaneOriginSchema.extend({
          status: z.enum(["ready", "failed"]),
        }),
      })
      .strict(),
  })
  .strict();

const eventSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    symbolIds: z.array(canonicalSymbolSchema).min(1).max(100),
    source: z.string().trim().min(1).max(64),
    sourceKind: z.enum([
      "market_quote",
      "market_trade",
      "sec_filing",
      "company_release",
      "licensed_news",
      "macro_series",
      "demo_fixture",
    ]),
    headline: z.string().trim().min(1).max(512),
    summary: z.string().trim().max(4_000).nullable(),
    publishedAt: timestampSchema,
    receivedAt: timestampSchema,
    providerUpdatedAt: timestampSchema.optional(),
    sourceUrl: safeSourceUrlSchema.nullable(),
    materiality: z.enum(["low", "medium", "high", "critical"]),
    isLive: z.boolean(),
    category: z
      .enum([
        "earnings",
        "filing",
        "macro",
        "market",
        "product",
        "governance",
        "executive",
        "legal",
        "regulatory",
        "reputation",
        "geopolitical",
      ])
      .optional(),
    claimStatus: z
      .enum([
        "confirmed",
        "official-investigation",
        "reported",
        "allegation",
        "disputed",
        "corrected",
      ])
      .optional(),
    causalLink: z
      .enum([
        "unassessed",
        "temporal-only",
        "plausible-contributor",
        "supported",
      ])
      .optional(),
    topicTags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    isControversial: z.boolean().optional(),
  })
  .strict();

const watchlistSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    isDefault: z.boolean(),
    itemCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

const readyMetaSchema = z
  .object({
    dataMode: z.enum(["live", "demo"]),
    mode: z.enum(["live", "demo"]),
    providerCoverage: z.enum(["complete", "partial", "demo"]),
    coverage: z.enum(["complete", "partial", "demo"]),
    generatedAt: timestampSchema,
    freshness: z
      .object({
        state: z.enum(["fresh", "stale", "unknown", "fixture"]),
        asOf: timestampSchema.nullable(),
        ageSeconds: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    providers: z.array(providerSchema).max(16),
    fallbackReason: z
      .enum(["provider_unconfigured", "provider_request_failed"])
      .optional(),
    notice: z.string().trim().min(1).max(2_000),
    readPlane: readPlaneSchema,
    scope: z.literal("personal"),
    status: z.literal("ready"),
  })
  .strict();

const readyEnvelopeBaseSchema = z
  .object({
    watchlists: z.array(watchlistSchema).max(100),
    symbols: z.array(canonicalSymbolSchema).min(1).max(100),
    data: z.array(eventSchema).max(100),
    meta: readyMetaSchema,
  })
  .strict();

function effectiveRevisionAt(event: z.infer<typeof eventSchema>) {
  const published = Date.parse(event.publishedAt);
  const revised = event.providerUpdatedAt
    ? Date.parse(event.providerUpdatedAt)
    : Number.NaN;
  return Number.isFinite(revised) && revised > published ? revised : published;
}

const readyEnvelopeSchema = readyEnvelopeBaseSchema.transform((envelope) => {
  const tracked = new Set(envelope.symbols);
  const order: string[] = [];
  const newestById = new Map<string, z.infer<typeof eventSchema>>();

  for (const candidate of envelope.data) {
    if (!candidate.symbolIds.some((symbol) => tracked.has(symbol))) continue;
    const event = {
      ...candidate,
      symbolIds: [...new Set(candidate.symbolIds)],
    };
    const current = newestById.get(event.id);
    if (!current) {
      order.push(event.id);
      newestById.set(event.id, event);
      continue;
    }
    if (
      effectiveRevisionAt(event) > effectiveRevisionAt(current) ||
      (effectiveRevisionAt(event) === effectiveRevisionAt(current) &&
        Date.parse(event.receivedAt) > Date.parse(current.receivedAt))
    ) {
      newestById.set(event.id, event);
    }
  }

  return {
    ...envelope,
    symbols: [...new Set(envelope.symbols)],
    data: order.flatMap((id) => {
      const event = newestById.get(id);
      return event ? [event] : [];
    }),
  };
});

const emptyEnvelopeSchema = z
  .object({
    watchlists: z.array(watchlistSchema).max(100),
    symbols: z.array(canonicalSymbolSchema).max(0),
    data: z.array(eventSchema).max(0),
    meta: z
      .object({
        scope: z.literal("personal"),
        status: z.literal("empty"),
        generatedAt: timestampSchema,
        notice: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  })
  .strict();

export const personalTodayEnvelopeSchema = z.union([
  readyEnvelopeSchema,
  emptyEnvelopeSchema,
]);

export type PersonalTodayEnvelope = z.infer<typeof personalTodayEnvelopeSchema>;
export type PersonalTodayEvent = z.infer<typeof eventSchema>;
export type PersonalTodayReadyEnvelope = z.infer<typeof readyEnvelopeSchema>;

export function parsePersonalTodayEnvelope(value: unknown): PersonalTodayEnvelope {
  return personalTodayEnvelopeSchema.parse(value);
}
