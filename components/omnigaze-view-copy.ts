import type { AppLocale } from "@/lib/app-locale";

type Stance = "bullish" | "bearish" | "mixed" | "neutral";
type Direction = "positive" | "negative" | "mixed" | "unclear";
type Coverage = "limited" | "moderate" | "strong";
type ProviderCoverage = "complete" | "partial";

interface OmnigazeViewCopy {
  dateLocale: string;
  timeUnavailable: string;
  eyebrow: string;
  intelligenceSuffix: string;
  close: string;
  gateTitle: string;
  gateBody: string;
  gateAction: string;
  idleTitle: string;
  idleBody: string;
  analyzeAction: string;
  loadingTitle: string;
  loadingBody: string;
  unavailableTitle: string;
  signInAgain: string;
  resumeSafely: string;
  tryNew: string;
  cachedFrom: string;
  generated: string;
  interpretationConfidence: string;
  notReturnProbability: string;
  evidenceCoverage: string;
  cacheReused: string;
  requestJoined: string;
  freshAnalysis: string;
  noAdditionalRequest: string;
  usageBoundary: string;
  whyNow: string;
  keyDrivers: string;
  importantUnknowns: string;
  unknownsDescription: string;
  citedEvidence: string;
  verifiedEvidence: string;
  disclaimer: string;
  refresh: string;
  stance: Record<Stance, string>;
  direction: Record<Direction, string>;
  coverage: Record<Coverage, string>;
  providerCoverage: Record<ProviderCoverage, string>;
  errors: Record<string, string>;
  retryAt(value: string): string;
  budgetUsed(remaining: number, limit: number, resetAt: string): string;
  driverCount(count: number): string;
  evidenceCount(items: number, sources: number): string;
  openSource(title: string): string;
  footerSummary(providerCoverage: string, asOf: string): string;
}

const english: OmnigazeViewCopy = {
  dateLocale: "en-US",
  timeUnavailable: "Time unavailable",
  eyebrow: "LIVE OMNIGAZE VIEW",
  intelligenceSuffix: "intelligence",
  close: "Close Omnigaze View",
  gateTitle: "Sign in for a live evidence-backed view",
  gateBody:
    "Omnigaze verifies the stock, evidence freshness, and citation set before asking the model to interpret anything.",
  gateAction: "Sign in to analyze",
  idleTitle: "Generate a fresh Omnigaze View",
  idleBody:
    "This starts one AI analysis using only currently verified, fresh provider evidence. It will not run until you ask.",
  analyzeAction: "Analyze live evidence",
  loadingTitle: "Building a grounded view",
  loadingBody: "Verifying live evidence, freshness, and citation integrity.",
  unavailableTitle: "View unavailable",
  signInAgain: "Sign in again",
  resumeSafely: "Resume request safely",
  tryNew: "Try a new analysis",
  cachedFrom: "Cached view from",
  generated: "Generated",
  interpretationConfidence: "interpretation confidence",
  notReturnProbability: "not a return probability",
  evidenceCoverage: "evidence coverage",
  cacheReused: "Verified analysis cache reused",
  requestJoined: "Joined an analysis already in progress",
  freshAnalysis: "Fresh model analysis generated",
  noAdditionalRequest: "No additional model request was charged for this view.",
  usageBoundary:
    "Usage controls manage AI cost and abuse. They are not a market signal, recommendation, or confidence score.",
  whyNow: "WHY NOW",
  keyDrivers: "KEY DRIVERS",
  importantUnknowns: "IMPORTANT UNKNOWNS",
  unknownsDescription: "What the evidence cannot establish",
  citedEvidence: "CITED EVIDENCE",
  verifiedEvidence: "Verified evidence",
  disclaimer: "Research support only. This is not investment advice.",
  refresh: "Refresh view",
  stance: {
    bullish: "Constructive",
    bearish: "Cautious",
    mixed: "Mixed",
    neutral: "Neutral",
  },
  direction: {
    positive: "positive",
    negative: "negative",
    mixed: "mixed",
    unclear: "unclear",
  },
  coverage: {
    limited: "limited",
    moderate: "moderate",
    strong: "strong",
  },
  providerCoverage: {
    complete: "complete",
    partial: "partial",
  },
  errors: {
    auth_required: "Authentication is required to generate an Omnigaze View.",
    invalid_request: "The analysis request is invalid.",
    invalid_guard_request: "The AI analysis request is invalid.",
    ai_unconfigured: "AI analysis is not configured in this environment.",
    symbol_not_supported: "Symbol not found.",
    asset_catalog_unavailable: "The asset catalog is temporarily unavailable.",
    live_evidence_required:
      "Live provider evidence is required for an Omnigaze View.",
    fresh_evidence_required:
      "Fresh provider evidence is required for an Omnigaze View.",
    insufficient_evidence: "No recent evidence is available for analysis.",
    ai_rate_limited: "The AI analysis budget is temporarily exhausted.",
    ai_guard_unavailable: "AI usage controls are temporarily unavailable.",
    analysis_failed: "Analysis could not be completed.",
    request_timeout:
      "Analysis timed out before a verified view was ready. Try again.",
    response_invalid:
      "The analysis response failed its integrity checks. Please try again.",
    network_error: "The Omnigaze View is temporarily unavailable.",
    fallback: "The Omnigaze View is temporarily unavailable.",
  },
  retryAt: (value) =>
    `Usage becomes available again around ${value}. This limit controls model requests, not investment confidence.`,
  budgetUsed: (remaining, limit, resetAt) =>
    `One model request used · ${remaining} of ${limit} remain until ${resetAt}.`,
  driverCount: (count) => `${count} grounded signal${count === 1 ? "" : "s"}`,
  evidenceCount: (items, sources) =>
    `${items} item${items === 1 ? "" : "s"} · ${sources} source${sources === 1 ? "" : "s"}`,
  openSource: (title) => `Open source: ${title}`,
  footerSummary: (coverage, asOf) =>
    `Live · ${coverage} coverage · evidence as of ${asOf}`,
};

const chinese: OmnigazeViewCopy = {
  dateLocale: "zh-CN",
  timeUnavailable: "时间不可用",
  eyebrow: "实时 OMNIGAZE 观点",
  intelligenceSuffix: "情报分析",
  close: "关闭 Omnigaze 观点",
  gateTitle: "登录后查看有实时证据支撑的观点",
  gateBody:
    "在请求模型解读前，Omnigaze 会先验证股票、证据时效性和引证集合。",
  gateAction: "登录并分析",
  idleTitle: "生成最新 Omnigaze 观点",
  idleBody:
    "仅在你明确点击后，系统才会使用当前已验证的最新提供商证据发起一次 AI 分析。",
  analyzeAction: "分析实时证据",
  loadingTitle: "正在生成有依据的观点",
  loadingBody: "正在验证实时证据、时效性和引证完整性。",
  unavailableTitle: "观点暂不可用",
  signInAgain: "重新登录",
  resumeSafely: "安全恢复请求",
  tryNew: "重新分析",
  cachedFrom: "缓存观点生成于",
  generated: "生成于",
  interpretationConfidence: "解读置信度",
  notReturnProbability: "并非收益概率",
  evidenceCoverage: "证据覆盖率",
  cacheReused: "已复用经验证的分析缓存",
  requestJoined: "已加入正在进行的分析",
  freshAnalysis: "已生成新的模型分析",
  noAdditionalRequest: "本次观点未额外消耗模型请求。",
  usageBoundary:
    "使用控制仅用于管理 AI 成本与滥用风险，并非市场信号、投资建议或置信度评分。",
  whyNow: "为何是现在",
  keyDrivers: "关键驱动因素",
  importantUnknowns: "重要未知因素",
  unknownsDescription: "现有证据无法确认的事项",
  citedEvidence: "引证证据",
  verifiedEvidence: "经验证的证据",
  disclaimer: "仅用于研究辅助，不构成投资建议。",
  refresh: "刷新观点",
  stance: {
    bullish: "偏积极",
    bearish: "偏谨慎",
    mixed: "多空交织",
    neutral: "中性",
  },
  direction: {
    positive: "正面",
    negative: "负面",
    mixed: "多空交织",
    unclear: "尚不明确",
  },
  coverage: {
    limited: "有限",
    moderate: "中等",
    strong: "充分",
  },
  providerCoverage: {
    complete: "完整",
    partial: "部分",
  },
  errors: {
    auth_required: "请先登录，再生成 Omnigaze 观点。",
    invalid_request: "分析请求无效。",
    invalid_guard_request: "AI 分析请求无效。",
    ai_unconfigured: "当前环境尚未配置 AI 分析。",
    symbol_not_supported: "未找到该股票代码。",
    asset_catalog_unavailable: "股票目录暂时不可用。",
    live_evidence_required: "生成 Omnigaze 观点需要实时提供商证据。",
    fresh_evidence_required: "生成 Omnigaze 观点需要最新的提供商证据。",
    insufficient_evidence: "目前没有足够的近期证据可供分析。",
    ai_rate_limited: "AI 分析额度暂时已用尽。",
    ai_guard_unavailable: "AI 使用控制暂时不可用。",
    analysis_failed: "无法完成分析。",
    request_timeout: "在取得可验证观点前，分析请求已超时，请重试。",
    response_invalid: "分析响应未通过完整性检查，请重试。",
    network_error: "Omnigaze 观点暂时不可用。",
    fallback: "Omnigaze 观点暂时不可用。",
  },
  retryAt: (value) =>
    `模型请求预计可在 ${value} 左右恢复。此限制仅控制模型请求，并不代表投资信心。`,
  budgetUsed: (remaining, limit, resetAt) =>
    `已使用 1 次模型请求 · 在 ${resetAt} 重置前，${limit} 次额度中还剩 ${remaining} 次。`,
  driverCount: (count) => `${count} 个有依据的信号`,
  evidenceCount: (items, sources) => `${items} 条证据 · ${sources} 个来源`,
  openSource: (title) => `打开来源：${title}`,
  footerSummary: (coverage, asOf) =>
    `实时 · ${coverage}覆盖 · 证据截至 ${asOf}`,
};

export const omnigazeViewCopy = {
  en: english,
  "zh-CN": chinese,
} satisfies Record<AppLocale, OmnigazeViewCopy>;

export function omnigazeViewErrorMessage(
  locale: AppLocale,
  code: string | null,
) {
  const copy = omnigazeViewCopy[locale];
  return (code && copy.errors[code]) || copy.errors.fallback;
}
