import { z } from "zod";
import {
  MOVE_LENS_BENCHMARK_NOTICE,
  MOVE_LENS_CAUSATION_NOTICE,
  MOVE_LENS_EVIDENCE_WINDOW_HOURS,
  MOVE_LENS_MAX_OBSERVATION_SKEW_SECONDS,
  moveLensBenchmarks,
  type MoveLensAggregateRelationship,
  type MoveLensBenchmarkResult,
  type MoveLensLeg,
  type MoveLensRelationship,
  type MoveLensResult,
} from "@/lib/move-lens";
import { isCredentialFreePublicHttpUrl } from "@/lib/security/public-http-url";

const MICRO_SCALE = BigInt(1_000_000);
const BASIS_POINTS = BigInt(10_000);
const MAX_QUOTE_AGE_SECONDS = 1_200;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

const canonicalSymbolSchema = z
  .string()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .max(64);

const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => new Date(Date.parse(value)).toISOString() === value,
    "Move Lens timestamps must be canonical UTC timestamps.",
  );

function safeTextSchema(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) => value === value.trim(),
      "Leading or trailing whitespace is not allowed.",
    )
    .refine(
      (value) => !/[\u0000-\u001F\u007F]/.test(value),
      "Control characters are not allowed.",
    );
}

const sourceUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    isCredentialFreePublicHttpUrl,
    "Move Lens source URLs must be credential-free HTTP(S) URLs.",
  )
  .nullable();

function micros(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1e15) return null;
  const [whole, fraction = ""] = value.toFixed(6).split(".");
  try {
    const result =
      BigInt(whole) * MICRO_SCALE + BigInt(fraction.padEnd(6, "0"));
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
  } catch {
    return null;
  }
}

function roundedDivide(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) return null;
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / BigInt(2)) / denominator;
  const result = negative ? -rounded : rounded;
  return result >= BigInt(Number.MIN_SAFE_INTEGER) &&
    result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result)
    : null;
}

function expectedObservationArithmetic(observation: {
  price: number;
  previousClose: number;
}) {
  const priceMicros = micros(observation.price);
  const previousCloseMicros = micros(observation.previousClose);
  if (priceMicros === null || previousCloseMicros === null) return null;
  const changeMicros = priceMicros - previousCloseMicros;
  const absoluteMoveBps = roundedDivide(
    changeMicros * BASIS_POINTS,
    previousCloseMicros,
  );
  const priceChange = Number(changeMicros) / Number(MICRO_SCALE);
  return absoluteMoveBps === null || !Number.isSafeInteger(Number(changeMicros))
    ? null
    : { absoluteMoveBps, priceChange };
}

const observationSchema = z
  .object({
    symbolId: canonicalSymbolSchema,
    price: z.number().finite().positive(),
    previousClose: z.number().finite().positive(),
    priceChange: z.number().finite(),
    absoluteMoveBps: z.number().int().safe(),
    asOf: timestampSchema,
    session: z.enum(["pre-market", "regular", "after-hours", "closed"]),
    provider: safeTextSchema(64),
    isDelayed: z.boolean(),
    delaySeconds: z.number().int().safe().nonnegative(),
    marketCoverage: z.enum(["limited-exchange", "consolidated"]),
  })
  .strict()
  .superRefine((observation, context) => {
    const expected = expectedObservationArithmetic(observation);
    if (
      !expected ||
      observation.priceChange !== expected.priceChange ||
      observation.absoluteMoveBps !== expected.absoluteMoveBps
    ) {
      context.addIssue({
        code: "custom",
        path: ["priceChange"],
        message: "Move Lens observation arithmetic is inconsistent.",
      });
    }
    if (
      (observation.isDelayed && observation.delaySeconds === 0) ||
      (!observation.isDelayed && observation.delaySeconds !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delaySeconds"],
        message: "Move Lens delay metadata is inconsistent.",
      });
    }
  });

const unavailableReasonSchema = z.enum([
  "snapshot_unavailable",
  "demo_suppressed",
  "identity_mismatch",
  "invalid_snapshot",
  "freshness_unverified",
]);

const comparisonUnavailableReasonSchema = z.enum([
  "selected_unavailable",
  "benchmark_unavailable",
  "session_mismatch",
  "delay_mismatch",
  "coverage_mismatch",
  "observation_skew",
]);

const selectedLegSchema = z.discriminatedUnion("status", [
  z
    .object({
      symbolId: canonicalSymbolSchema,
      ticker: z.string().regex(/^[A-Z0-9._-]{1,32}$/),
      label: safeTextSchema(128),
      assetType: z.literal("selected_security"),
      status: z.literal("available"),
      observation: observationSchema,
    })
    .strict(),
  z
    .object({
      symbolId: canonicalSymbolSchema,
      ticker: z.string().regex(/^[A-Z0-9._-]{1,32}$/),
      label: safeTextSchema(128),
      assetType: z.literal("selected_security"),
      status: z.literal("unavailable"),
      observation: z.null(),
      reason: unavailableReasonSchema,
    })
    .strict(),
]);

const benchmarkFields = {
  key: z.enum(["spy", "qqq"]),
  symbolId: canonicalSymbolSchema,
  ticker: z.string().regex(/^[A-Z0-9._-]{1,32}$/),
  label: safeTextSchema(128),
  assetType: z.literal("etf_proxy"),
  relationship: z.enum(["ahead", "behind", "equal"]).nullable(),
  relativeMoveBps: z.number().int().safe().nullable(),
  comparisonUnavailableReason: comparisonUnavailableReasonSchema.nullable(),
} as const;

const benchmarkResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...benchmarkFields,
      status: z.literal("available"),
      observation: observationSchema,
    })
    .strict(),
  z
    .object({
      ...benchmarkFields,
      status: z.literal("unavailable"),
      observation: z.null(),
      reason: unavailableReasonSchema,
    })
    .strict(),
]);

const relatedEventSchema = z
  .object({
    id: safeTextSchema(256),
    symbolIds: z.array(canonicalSymbolSchema).min(1).max(100),
    source: safeTextSchema(200),
    sourceKind: z.enum([
      "market_quote",
      "market_trade",
      "sec_filing",
      "company_release",
      "licensed_news",
      "macro_series",
    ]),
    headline: safeTextSchema(500),
    summary: safeTextSchema(2_000).nullable(),
    publishedAt: timestampSchema,
    providerUpdatedAt: timestampSchema.nullable(),
    sourceUrl: sourceUrlSchema,
    materiality: z.enum(["low", "medium", "high", "critical"]),
    claimStatus: z
      .enum([
        "confirmed",
        "official-investigation",
        "reported",
        "allegation",
        "disputed",
        "corrected",
      ])
      .nullable(),
    causalLink: z.enum(["unassessed", "temporal-only"]).nullable(),
    isControversial: z.boolean(),
  })
  .strict();

function tickerFor(symbolId: string) {
  return symbolId.split(":", 2)[1] ?? symbolId;
}

function relationshipFor(relativeMoveBps: number): MoveLensRelationship {
  return relativeMoveBps > 0
    ? "ahead"
    : relativeMoveBps < 0
      ? "behind"
      : "equal";
}

function compatibilityReason(
  selected: MoveLensLeg,
  benchmark: MoveLensBenchmarkResult,
) {
  if (selected.status !== "available") return "selected_unavailable" as const;
  if (benchmark.status !== "available") {
    return "benchmark_unavailable" as const;
  }
  if (selected.observation.session !== benchmark.observation.session) {
    return "session_mismatch" as const;
  }
  if (
    selected.observation.isDelayed !== benchmark.observation.isDelayed ||
    selected.observation.delaySeconds !== benchmark.observation.delaySeconds
  ) {
    return "delay_mismatch" as const;
  }
  if (
    selected.observation.marketCoverage !==
    benchmark.observation.marketCoverage
  ) {
    return "coverage_mismatch" as const;
  }
  if (
    Math.abs(
      Date.parse(selected.observation.asOf) -
        Date.parse(benchmark.observation.asOf),
    ) >
    MOVE_LENS_MAX_OBSERVATION_SKEW_SECONDS * 1_000
  ) {
    return "observation_skew" as const;
  }
  return null;
}

function expectedAggregate(
  relationships: MoveLensRelationship[],
): MoveLensAggregateRelationship | null {
  if (relationships.length !== moveLensBenchmarks.length) return null;
  const directional = relationships.filter(
    (relationship) => relationship !== "equal",
  );
  if (directional.length === 0) return "equal";
  if (directional.every((relationship) => relationship === "ahead")) {
    return "ahead";
  }
  if (directional.every((relationship) => relationship === "behind")) {
    return "behind";
  }
  return "mixed";
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  context.addIssue({ code: "custom", path, message });
}

export const moveLensEnvelopeSchema = z
  .object({
    data: z
      .object({
        symbolId: canonicalSymbolSchema,
        status: z.enum(["complete", "partial", "unavailable"]),
        selected: selectedLegSchema,
        benchmarks: z
          .array(benchmarkResultSchema)
          .length(moveLensBenchmarks.length),
        aggregateRelationship: z
          .enum(["ahead", "behind", "equal", "mixed"])
          .nullable(),
        latestRelatedEvent: relatedEventSchema.nullable(),
        causationAssessment: z.literal("not_assessed"),
        modelUsed: z.literal(false),
        tradeExecutionAllowed: z.literal(false),
      })
      .strict(),
    meta: z
      .object({
        generatedAt: timestampSchema,
        comparableBenchmarkCount: z.number().int().min(0).max(2),
        requestedBenchmarkCount: z.literal(moveLensBenchmarks.length),
        evidenceStatus: z.enum(["available", "none", "unavailable"]),
        benchmarkNotice: z.literal(MOVE_LENS_BENCHMARK_NOTICE),
        causationNotice: z.literal(MOVE_LENS_CAUSATION_NOTICE),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const { data, meta } = envelope;
    const expectedTicker = tickerFor(data.symbolId);
    if (
      data.selected.symbolId !== data.symbolId ||
      data.selected.ticker !== expectedTicker ||
      data.selected.label !== `${expectedTicker} selected security`
    ) {
      addIssue(
        context,
        ["data", "selected"],
        "Selected Move Lens identity is inconsistent.",
      );
    }
    if (
      data.selected.status === "available" &&
      data.selected.observation.symbolId !== data.selected.symbolId
    ) {
      addIssue(
        context,
        ["data", "selected", "observation", "symbolId"],
        "Selected observation identity is inconsistent.",
      );
    }

    data.benchmarks.forEach((benchmark, index) => {
      const expected = moveLensBenchmarks[index];
      if (
        benchmark.key !== expected.key ||
        benchmark.symbolId !== expected.symbolId ||
        benchmark.ticker !== expected.ticker ||
        benchmark.label !== expected.label ||
        benchmark.assetType !== expected.assetType
      ) {
        addIssue(
          context,
          ["data", "benchmarks", index],
          "Move Lens benchmark identity or order is inconsistent.",
        );
      }
      if (
        benchmark.status === "available" &&
        benchmark.observation.symbolId !== benchmark.symbolId
      ) {
        addIssue(
          context,
          ["data", "benchmarks", index, "observation", "symbolId"],
          "Benchmark observation identity is inconsistent.",
        );
      }

      const unavailableReason = compatibilityReason(
        data.selected as MoveLensLeg,
        benchmark as MoveLensBenchmarkResult,
      );
      if (unavailableReason) {
        if (
          benchmark.relationship !== null ||
          benchmark.relativeMoveBps !== null ||
          benchmark.comparisonUnavailableReason !== unavailableReason
        ) {
          addIssue(
            context,
            ["data", "benchmarks", index, "relationship"],
            "Unavailable Move Lens comparison contains inconsistent output.",
          );
        }
        return;
      }
      if (
        data.selected.status !== "available" ||
        benchmark.status !== "available"
      ) {
        return;
      }
      const expectedRelativeMoveBps =
        data.selected.observation.absoluteMoveBps -
        benchmark.observation.absoluteMoveBps;
      if (
        !Number.isSafeInteger(expectedRelativeMoveBps) ||
        benchmark.relativeMoveBps !== expectedRelativeMoveBps ||
        benchmark.relationship !== relationshipFor(expectedRelativeMoveBps) ||
        benchmark.comparisonUnavailableReason !== null
      ) {
        addIssue(
          context,
          ["data", "benchmarks", index, "relativeMoveBps"],
          "Move Lens relative arithmetic or relationship is inconsistent.",
        );
      }
    });

    const comparableRelationships = data.benchmarks.flatMap((benchmark) =>
      benchmark.relationship ? [benchmark.relationship] : [],
    );
    const comparableBenchmarkCount = comparableRelationships.length;
    const expectedStatus =
      data.selected.status !== "available"
        ? "unavailable"
        : comparableBenchmarkCount === moveLensBenchmarks.length
          ? "complete"
          : "partial";
    if (
      meta.comparableBenchmarkCount !== comparableBenchmarkCount ||
      data.status !== expectedStatus ||
      data.aggregateRelationship !== expectedAggregate(comparableRelationships)
    ) {
      addIssue(
        context,
        ["meta", "comparableBenchmarkCount"],
        "Move Lens status, count, or aggregate relationship is inconsistent.",
      );
    }

    const expectedEvidenceStatus = data.latestRelatedEvent
      ? "available"
      : meta.evidenceStatus === "unavailable"
        ? "unavailable"
        : "none";
    if (meta.evidenceStatus !== expectedEvidenceStatus) {
      addIssue(
        context,
        ["meta", "evidenceStatus"],
        "Move Lens evidence status is inconsistent.",
      );
    }
    if (data.latestRelatedEvent) {
      const event = data.latestRelatedEvent;
      if (
        !event.symbolIds.includes(data.symbolId) ||
        new Set(event.symbolIds).size !== event.symbolIds.length ||
        [...event.symbolIds].sort().some(
          (symbolId, index) => symbolId !== event.symbolIds[index],
        )
      ) {
        addIssue(
          context,
          ["data", "latestRelatedEvent", "symbolIds"],
          "Move Lens evidence identity is inconsistent.",
        );
      }
      const generatedAtMs = Date.parse(meta.generatedAt);
      const publishedAtMs = Date.parse(event.publishedAt);
      const providerUpdatedAtMs = event.providerUpdatedAt
        ? Date.parse(event.providerUpdatedAt)
        : null;
      const sinceMs =
        generatedAtMs - MOVE_LENS_EVIDENCE_WINDOW_HOURS * 60 * 60 * 1_000;
      const futureLimitMs =
        generatedAtMs + MAX_FUTURE_SKEW_SECONDS * 1_000;
      if (
        publishedAtMs < sinceMs ||
        publishedAtMs > futureLimitMs ||
        (providerUpdatedAtMs !== null &&
          providerUpdatedAtMs > futureLimitMs)
      ) {
        addIssue(
          context,
          ["data", "latestRelatedEvent", "publishedAt"],
          "Move Lens evidence falls outside the declared daily window.",
        );
      }
    }

    const observations = [
      data.selected.status === "available"
        ? data.selected.observation
        : null,
      ...data.benchmarks.map((benchmark) =>
        benchmark.status === "available" ? benchmark.observation : null,
      ),
    ].filter((observation) => observation !== null);
    const generatedAtMs = Date.parse(meta.generatedAt);
    observations.forEach((observation, index) => {
      const asOfMs = Date.parse(observation.asOf);
      const actualAgeSeconds = Math.max(
        0,
        Math.round((generatedAtMs - asOfMs) / 1_000),
      );
      const maximumAgeSeconds = Math.max(
        MAX_QUOTE_AGE_SECONDS,
        observation.delaySeconds + 300,
      );
      if (
        asOfMs > generatedAtMs + MAX_FUTURE_SKEW_SECONDS * 1_000 ||
        actualAgeSeconds > maximumAgeSeconds
      ) {
        addIssue(
          context,
          ["data", index === 0 ? "selected" : "benchmarks"],
          "Move Lens observation freshness is inconsistent.",
        );
      }
    });
  });

export type MoveLensEnvelope = z.infer<typeof moveLensEnvelopeSchema>;

export function parseMoveLensEnvelope(value: unknown): MoveLensResult {
  return moveLensEnvelopeSchema.parse(value) as MoveLensResult;
}
