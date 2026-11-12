import { z } from "zod";
import {
  assertGroundedAnalysis,
  OMNIGAZE_ANALYSIS_PROMPT_VERSION,
  omnigazeAnalysisSchema,
  type OmnigazeAnalysis,
} from "@/lib/ai/analysis-contract";
import { buildAnalysisContextFromFeed } from "@/lib/ai/build-analysis-context";
import {
  OmnigazeAiGuard,
  resolveOmnigazeModelConfig,
  type GuardedOmnigazeViewInput,
  type GuardedOmnigazeViewResult,
} from "@/lib/ai/omnigaze-view-guard";
import type { CanonicalSymbol, Evidence, Instrument } from "@/lib/market-types";
import type { AppLocale } from "@/lib/app-locale";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";
import { intelligenceReadPlane } from "@/lib/services/intelligence-read-plane";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
  type ResolvedInstrument,
} from "@/lib/services/instrument-resolution";

const AI_EVIDENCE_MAX_AGE_SECONDS = 24 * 60 * 60;
const textEncoder = new TextEncoder();
const prohibitedAnalysisGuidancePatterns = [
  /\b(?:you\s+should|we\s+(?:recommend|suggest)(?:\s+that\s+you)?|omnigaze\s+(?:recommends|suggests)(?:\s+that\s+you)?)\s+(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|trim(?:ming)?|add(?:ing)?|reduc(?:e|ing))\b/i,
  /(?:^|[\n.!?]\s*)(?:buy|sell|hold|trim|reduce)\s+(?:[A-Z]{1,6}\b|the\s+(?:stock|shares?|position)\b|your\s+(?:shares?|position)\b)/i,
  /\b(?:price\s+target|target\s+price)\s*(?:(?:is|of|at|:|-)\s*)?(?:[$€£¥]\s*)?\d/i,
  /\b(?:buy|sell|trim|add|reduce)\s+\d[\d,.]*\s+(?:shares?|units?|contracts?)\b/i,
  /\b(?:guaranteed\s+to|will\s+definitely|must)\s+(?:rise|fall|gain|drop|rally|decline|outperform|underperform)\b/i,
  /(?:建议|推荐|应该|应当|需要|可以考虑|不妨|最好)(?:你|您)?\s*(?:买入|卖出|持有|加仓|减仓|清仓|做多|做空)/,
  /(?:买入|卖出|持有|加仓|减仓|清仓)\s*\d[\d,.]*\s*股/,
  /(?:目标价|目标价格)\s*(?:为|是|：|:)?\s*[¥￥$]?\s*\d/,
  /(?:一定|必然|肯定|保证会)\s*(?:上涨|下跌|涨|跌|跑赢|跑输)/,
] as const;

export function assertOmnigazeAnalysisPolicy(analysis: OmnigazeAnalysis) {
  const modelAuthoredText = [
    analysis.headline,
    analysis.summary,
    analysis.whyNow,
    ...analysis.drivers.flatMap((driver) => [driver.label, driver.explanation]),
    ...analysis.unknowns,
  ].join("\n");
  if (prohibitedAnalysisGuidancePatterns.some((pattern) => pattern.test(modelAuthoredText))) {
    throw new Error("prohibited_trade_guidance");
  }
}

export function assertOmnigazeAnalysisLocale(
  analysis: OmnigazeAnalysis,
  locale: AppLocale,
) {
  if (locale !== "zh-CN") return;
  const modelAuthoredFields = [
    analysis.headline,
    analysis.summary,
    analysis.whyNow,
    ...analysis.drivers.flatMap((driver) => [driver.label, driver.explanation]),
    ...analysis.unknowns,
  ];
  if (modelAuthoredFields.some((value) => !/[\u3400-\u9fff]/u.test(value))) {
    throw new Error("analysis_locale_mismatch");
  }
}

export type OmnigazeViewErrorCode =
  | "ai_unconfigured"
  | "symbol_not_supported"
  | "asset_catalog_unavailable"
  | "live_evidence_required"
  | "fresh_evidence_required"
  | "insufficient_evidence";

const errorContract: Record<
  OmnigazeViewErrorCode,
  { status: number; message: string }
> = {
  ai_unconfigured: {
    status: 503,
    message: "AI analysis is not configured in this environment.",
  },
  symbol_not_supported: { status: 404, message: "Symbol not found." },
  asset_catalog_unavailable: {
    status: 503,
    message: "The asset catalog is temporarily unavailable.",
  },
  live_evidence_required: {
    status: 422,
    message: "Live provider evidence is required for an Omnigaze View.",
  },
  fresh_evidence_required: {
    status: 422,
    message: "Fresh provider evidence is required for an Omnigaze View.",
  },
  insufficient_evidence: {
    status: 422,
    message: "No recent evidence is available for analysis.",
  },
};

export class OmnigazeViewError extends Error {
  readonly status: number;

  constructor(readonly code: OmnigazeViewErrorCode) {
    const contract = errorContract[code];
    super(contract.message);
    this.name = "OmnigazeViewError";
    this.status = contract.status;
  }
}

const citationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    publisher: z.string().min(1),
    publishedAt: z.string().datetime({ offset: true }),
    url: z.string().url().nullable(),
    classification: z.enum(["fact", "derived", "inference"]),
  })
  .strict();

const cachedOmnigazeViewSchema = z
  .object({
    data: omnigazeAnalysisSchema,
    meta: z
      .object({
        symbolId: z
          .string()
          .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
          .transform((value) => value as CanonicalSymbol),
        dataCutoff: z.string().datetime({ offset: true }),
        generatedAt: z.string().datetime({ offset: true }),
        promptVersion: z.string().min(1).max(128),
        dataMode: z.literal("live"),
        providerCoverage: z.enum(["complete", "partial"]),
        freshness: z
          .object({
            state: z.literal("fresh"),
            asOf: z.string().datetime({ offset: true }),
            ageSeconds: z.number().int().nonnegative(),
          })
          .strict(),
        evidenceCount: z.number().int().positive(),
        eventCount: z.number().int().positive(),
        sources: z.array(z.string().min(1)).min(1),
        evidenceCoverage: z
          .object({
            score: z.number().min(0).max(1),
            label: z.enum(["limited", "moderate", "strong"]),
            evidenceCount: z.number().int().positive(),
            sourceCount: z.number().int().positive(),
          })
          .strict(),
        citations: z.array(citationSchema).min(1),
        confidenceMeaning: z.literal(
          "evidence_interpretation_not_return_probability",
        ),
        disclaimer: z.string().min(1),
      })
      .strict(),
  })
  .strict();

type CachedOmnigazeView = z.infer<typeof cachedOmnigazeViewSchema>;
type AiGuardMeta = GuardedOmnigazeViewResult<CachedOmnigazeView>["meta"];

export type GeneratedOmnigazeView = Omit<CachedOmnigazeView, "meta"> & {
  meta: CachedOmnigazeView["meta"] & {
    ai: AiGuardMeta & { servedAt: string };
  };
};

type OmnigazeViewGuard = {
  execute(
    input: GuardedOmnigazeViewInput<CachedOmnigazeView>,
  ): Promise<GuardedOmnigazeViewResult<CachedOmnigazeView>>;
};

type OmnigazeViewDependencies = {
  resolveInstrument(symbolId: CanonicalSymbol): Promise<ResolvedInstrument>;
  getIntelligenceFeed(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<OrchestratedIntelligenceFeed>;
  analyze(input: {
    instrument: Instrument;
    evidence: Evidence[];
    events: ReturnType<typeof buildAnalysisContextFromFeed>["events"];
    dataCutoff: string;
    locale: AppLocale;
  }): Promise<OmnigazeAnalysis>;
  guard: OmnigazeViewGuard;
  modelConfig(): string;
  now(): Date;
  isAiConfigured(): boolean;
};

const cachedViewCodec = {
  encode(value: CachedOmnigazeView) {
    return cachedOmnigazeViewSchema.parse(value);
  },
  decode(value: unknown) {
    return cachedOmnigazeViewSchema.parse(value);
  },
};

let defaultGuardInstance: OmnigazeAiGuard<CachedOmnigazeView> | null = null;
const defaultGuard: OmnigazeViewGuard = {
  async execute(input) {
    if (!defaultGuardInstance) {
      const { aiGuardrailsRepository } = await import(
        "@/lib/ai/guardrails-repository"
      );
      defaultGuardInstance = new OmnigazeAiGuard(
        aiGuardrailsRepository,
        cachedViewCodec,
      );
    }
    return defaultGuardInstance.execute(input);
  },
};

const defaultDependencies: OmnigazeViewDependencies = {
  resolveInstrument: resolveCanonicalInstrument,
  getIntelligenceFeed: (options) =>
    intelligenceReadPlane.getIntelligenceFeed(options),
  analyze: async (input) => {
    const { analyzeEvidence } = await import("@/lib/ai/analyze-evidence");
    return analyzeEvidence(input);
  },
  guard: defaultGuard,
  modelConfig: () => resolveOmnigazeModelConfig(process.env.OPENAI_MODEL),
  now: () => new Date(),
  isAiConfigured: () => Boolean(process.env.OPENAI_API_KEY),
};

function instrumentFromResolved(resolved: ResolvedInstrument): Instrument {
  return {
    id: resolved.id,
    ticker: resolved.ticker,
    exchange: resolved.exchange,
    name: resolved.name,
    sector: resolved.sector ?? "Unclassified",
    currency: resolved.currency,
  };
}

function coverageFor(evidence: Evidence[]) {
  const sourceCount = new Set(evidence.map((item) => item.publisher)).size;
  const evidenceScore = Math.min(evidence.length, 5) / 5;
  const sourceScore = Math.min(sourceCount, 3) / 3;
  const score =
    Math.round((0.2 + evidenceScore * 0.5 + sourceScore * 0.3) * 100) / 100;
  const label: "limited" | "moderate" | "strong" =
    score >= 0.75 ? "strong" : score >= 0.5 ? "moderate" : "limited";
  return { score, label, evidenceCount: evidence.length, sourceCount };
}

function citationsFor(evidence: Evidence[]) {
  return evidence.map((item) => ({
    id: item.id,
    title: item.title,
    publisher: item.publisher,
    publishedAt: item.publishedAt,
    url: item.url,
    classification: item.classification,
  }));
}

function relevantLiveItems(
  items: IntelligenceFeedItem[],
  symbolId: CanonicalSymbol,
) {
  const byId = new Map<string, IntelligenceFeedItem>();
  for (const item of items) {
    if (
      !item.isLive ||
      (item.symbolIds.length > 0 && !item.symbolIds.includes(symbolId))
    ) {
      continue;
    }
    const current = byId.get(item.id);
    const itemRevision = Date.parse(item.providerUpdatedAt ?? item.publishedAt);
    const currentRevision = current
      ? Date.parse(current.providerUpdatedAt ?? current.publishedAt)
      : Number.NEGATIVE_INFINITY;
    if (!current || itemRevision > currentRevision) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintItems(items: IntelligenceFeedItem[]) {
  return Promise.all(
    items.map(async (item) => ({
      id: `evidence:${item.id}`,
      revisionAt: item.providerUpdatedAt ?? item.publishedAt,
      contentHash: await sha256(
        JSON.stringify({
          id: item.id,
          symbolIds: [...new Set(item.symbolIds)].sort(),
          source: item.source,
          sourceKind: item.sourceKind,
          headline: item.headline,
          summary: item.summary,
          publishedAt: item.publishedAt,
          providerUpdatedAt: item.providerUpdatedAt ?? null,
          sourceUrl: item.sourceUrl,
          materiality: item.materiality,
          category: item.category ?? null,
          claimStatus: item.claimStatus ?? null,
          causalLink: item.causalLink ?? null,
          topicTags: [...new Set(item.topicTags ?? [])].sort(),
          isControversial: item.isControversial === true,
        }),
      ),
    })),
  );
}

function coreView(
  analysis: OmnigazeAnalysis,
  input: {
    symbolId: CanonicalSymbol;
    context: ReturnType<typeof buildAnalysisContextFromFeed>;
    feed: OrchestratedIntelligenceFeed;
    generatedAt: string;
    promptVersion: string;
  },
) {
  return cachedOmnigazeViewSchema.parse({
    data: analysis,
    meta: {
      symbolId: input.symbolId,
      dataCutoff: input.context.dataCutoff,
      generatedAt: input.generatedAt,
      promptVersion: input.promptVersion,
      dataMode: "live",
      providerCoverage: input.context.sourceMeta.providerCoverage,
      freshness: {
        state: "fresh",
        asOf: input.feed.meta.freshness.asOf,
        ageSeconds: input.feed.meta.freshness.ageSeconds,
      },
      evidenceCount: input.context.evidence.length,
      eventCount: input.context.events.length,
      sources: [
        ...new Set(input.context.evidence.map((item) => item.publisher)),
      ].sort(),
      evidenceCoverage: coverageFor(input.context.evidence),
      citations: citationsFor(input.context.evidence),
      confidenceMeaning: "evidence_interpretation_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  });
}

export interface GenerateOmnigazeViewRequest {
  ownerId: string;
  requestId?: string;
  locale?: AppLocale;
}

export function omnigazeAnalysisPromptVersion(locale: AppLocale) {
  return `${OMNIGAZE_ANALYSIS_PROMPT_VERSION}:${locale}`;
}

export async function generateOmnigazeView(
  symbolId: CanonicalSymbol,
  request: GenerateOmnigazeViewRequest,
  dependencies: Partial<OmnigazeViewDependencies> = {},
): Promise<GeneratedOmnigazeView> {
  const deps = { ...defaultDependencies, ...dependencies };
  const locale: AppLocale = request.locale === "zh-CN" ? "zh-CN" : "en";
  const promptVersion = omnigazeAnalysisPromptVersion(locale);
  if (!deps.isAiConfigured()) throw new OmnigazeViewError("ai_unconfigured");

  let resolved: ResolvedInstrument;
  try {
    resolved = await deps.resolveInstrument(symbolId);
  } catch (error) {
    if (error instanceof InstrumentResolutionError) {
      throw new OmnigazeViewError(error.code);
    }
    throw error;
  }

  const now = deps.now();
  const feed = await deps.getIntelligenceFeed({
    symbols: [resolved.id],
    since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    limit: 30,
  });
  if (feed.meta.dataMode !== "live") {
    throw new OmnigazeViewError("live_evidence_required");
  }
  if (
    feed.meta.freshness.state !== "fresh" ||
    !feed.meta.freshness.asOf ||
    feed.meta.freshness.ageSeconds === null
  ) {
    throw new OmnigazeViewError("fresh_evidence_required");
  }

  const liveItems = relevantLiveItems(feed.data, resolved.id);
  const instrument = instrumentFromResolved(resolved);
  const context = buildAnalysisContextFromFeed({
    instrument,
    items: liveItems,
    meta: feed.meta,
  });
  if (context.evidence.length === 0) {
    throw new OmnigazeViewError("insufficient_evidence");
  }

  const guarded = await deps.guard.execute({
    ownerId: request.ownerId,
    symbolId: resolved.id,
    promptVersion,
    modelConfig: deps.modelConfig(),
    requestId: request.requestId,
    freshness: {
      state: "fresh",
      asOf: feed.meta.freshness.asOf,
      maximumAgeSeconds: AI_EVIDENCE_MAX_AGE_SECONDS,
    },
    fingerprint: { evidence: await fingerprintItems(liveItems) },
    generate: async () => {
      const analysis = await deps.analyze({ ...context, locale });
      assertGroundedAnalysis(
        analysis,
        context.evidence.map((item) => item.id),
      );
      assertOmnigazeAnalysisPolicy(analysis);
      assertOmnigazeAnalysisLocale(analysis, locale);
      return coreView(analysis, {
        symbolId: resolved.id,
        context,
        feed,
        generatedAt: deps.now().toISOString(),
        promptVersion,
      });
    },
  });

  assertGroundedAnalysis(
    guarded.value.data,
    context.evidence.map((item) => item.id),
  );
  assertOmnigazeAnalysisPolicy(guarded.value.data);
  assertOmnigazeAnalysisLocale(guarded.value.data, locale);

  const current = coreView(guarded.value.data, {
    symbolId: resolved.id,
    context,
    feed,
    generatedAt: guarded.value.meta.generatedAt,
    promptVersion,
  });
  return {
    ...current,
    meta: {
      ...current.meta,
      ai: { ...guarded.meta, servedAt: deps.now().toISOString() },
    },
  };
}
