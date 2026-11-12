import type { AppLocale } from "@/lib/app-locale";
import type {
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
} from "@/lib/market-types";

type EventCategory = IntelligenceEvent["category"];

export interface MoveLensCopy {
  dateLocale: string;
  eyebrow: string;
  title: (ticker: string) => string;
  subtitle: string;
  selectedMove: string;
  etfProxy: string;
  relativeGap: string;
  percentagePoints: (value: string) => string;
  waiting: string;
  loadingTitle: string;
  loadingBody: string;
  verifiedContext: string;
  unavailableTitle: string;
  unavailableBody: string;
  refreshDelayed: string;
  retainedDetail: string;
  partialTitle: string;
  partialDetail: string;
  comparisonWithheld: string;
  incompatibleSession: string;
  observationMismatch: string;
  metadataMismatch: string;
  staleComparison: string;
  providerUnavailable: string;
  fixtureSuppressed: string;
  latestEvidence: string;
  evidenceLoading: string;
  evidenceUnavailable: string;
  noEvidenceTitle: string;
  noEvidenceBody: string;
  openSource: string;
  sourceUnavailable: string;
  controversy: string;
  originalLanguage: string;
  providerObservation: (value: string) => string;
  providerAndTime: (provider: string, value: string) => string;
  delayed: (minutes: number) => string;
  limitedCoverage: string;
  consolidatedCoverage: string;
  timestampUnavailable: string;
  disclosure: string;
  cardAria: (ticker: string) => string;
  moveAria: (ticker: string, value: string) => string;
  gapAria: (ticker: string, proxy: string, value: string) => string;
  category: Record<EventCategory, string>;
  claimStatus: Record<ClaimStatus, string>;
  causalLink: Record<CausalLink, string>;
  benchmarkLabels: Record<"spy" | "qqq", string>;
}

const categoryEn: Record<EventCategory, string> = {
  earnings: "Earnings",
  filing: "Filing",
  macro: "Macro",
  market: "Market",
  product: "Product",
  governance: "Governance",
  executive: "Executive",
  legal: "Legal",
  regulatory: "Regulatory",
  reputation: "Reputation",
  geopolitical: "Geopolitical",
};

const categoryZh: Record<EventCategory, string> = {
  earnings: "财报",
  filing: "申报文件",
  macro: "宏观",
  market: "市场",
  product: "产品",
  governance: "公司治理",
  executive: "高管",
  legal: "法律",
  regulatory: "监管",
  reputation: "声誉",
  geopolitical: "地缘政治",
};

export const moveLensCopy: Record<AppLocale, MoveLensCopy> = {
  en: {
    dateLocale: "en-US",
    eyebrow: "MOVE LENS",
    title: (ticker) => `${ticker} versus market proxies`,
    subtitle:
      "Daily price movement beside broad-market and growth ETF proxies.",
    selectedMove: "Selected stock",
    etfProxy: "ETF proxy",
    relativeGap: "Relative gap",
    percentagePoints: (value) => `${value} pts`,
    waiting: "Waiting for a verified provider observation",
    loadingTitle: "Building current move context",
    loadingBody: "Checking the selected quote, ETF proxies, and relevant evidence.",
    verifiedContext: "Verified provider context",
    unavailableTitle: "Move comparison unavailable",
    unavailableBody:
      "Omnigaze could not verify enough current provider data for this comparison.",
    refreshDelayed: "Refresh delayed",
    retainedDetail: "The last verified market context remains visible.",
    partialTitle: "Partial proxy coverage",
    partialDetail: "Available proxies remain visible; missing comparisons are withheld.",
    comparisonWithheld: "Comparison withheld",
    incompatibleSession: "Provider observations are from different market sessions.",
    observationMismatch: "Provider observation times are too far apart to compare.",
    metadataMismatch:
      "Provider delay or market-coverage terms do not match, so the relative gap is withheld.",
    staleComparison: "At least one observation is stale or not current.",
    providerUnavailable: "A required provider observation is unavailable.",
    fixtureSuppressed: "Illustrative fixture values are never used in Move Lens.",
    latestEvidence: "Latest relevant evidence",
    evidenceLoading: "Checking current relevant evidence.",
    evidenceUnavailable: "Current relevant evidence could not be verified.",
    noEvidenceTitle: "No current relevant evidence",
    noEvidenceBody:
      "No current non-demo provider event is available for this selected stock.",
    openSource: "Open source",
    sourceUnavailable: "Source link unavailable",
    controversy: "Controversial",
    originalLanguage: "Source text remains in its original language.",
    providerObservation: (value) => `Provider observation ${value}`,
    providerAndTime: (provider, value) => `${provider} · ${value}`,
    delayed: (minutes) => `Delayed ${minutes}m`,
    limitedCoverage: "Limited-exchange coverage",
    consolidatedCoverage: "Consolidated coverage",
    timestampUnavailable: "Time unavailable",
    disclosure:
      "Relative movement and nearby evidence show correlation and context, not proof of causation.",
    cardAria: (ticker) => `${ticker} Move Lens`,
    moveAria: (ticker, value) => `${ticker} daily move ${value}`,
    gapAria: (ticker, proxy, value) =>
      `${ticker} relative gap versus ${proxy}: ${value} percentage points`,
    category: categoryEn,
    claimStatus: {
      confirmed: "Confirmed",
      "official-investigation": "Official investigation",
      reported: "Reported",
      allegation: "Allegation",
      disputed: "Disputed",
      corrected: "Corrected",
    },
    causalLink: {
      supported: "Supported contributor",
      "plausible-contributor": "Plausible contributor",
      "temporal-only": "Timing overlap only",
      unassessed: "Causal link unassessed",
    },
    benchmarkLabels: {
      spy: "S&P 500 ETF proxy",
      qqq: "Nasdaq-100 ETF proxy",
    },
  },
  "zh-CN": {
    dateLocale: "zh-CN",
    eyebrow: "走势透镜",
    title: (ticker) => `${ticker} 与市场代理对比`,
    subtitle: "将当日股价走势与大盘及成长型 ETF 代理并列查看。",
    selectedMove: "所选股票",
    etfProxy: "ETF 代理",
    relativeGap: "相对差值",
    percentagePoints: (value) => `${value} 个百分点`,
    waiting: "正在等待经验证的供应商观测数据",
    loadingTitle: "正在建立当前走势背景",
    loadingBody: "正在核对所选股票报价、ETF 代理与相关证据。",
    verifiedContext: "已验证的供应商背景",
    unavailableTitle: "走势比较不可用",
    unavailableBody: "当前没有足够的已验证供应商数据用于比较。",
    refreshDelayed: "刷新延迟",
    retainedDetail: "仍显示上一次经验证的市场背景。",
    partialTitle: "ETF 代理覆盖不完整",
    partialDetail: "仍显示可用的代理；缺失的比较会被保留不显示。",
    comparisonWithheld: "暂不比较",
    incompatibleSession: "供应商观测来自不同的交易时段。",
    observationMismatch: "供应商观测时间相差过大，无法可靠比较。",
    metadataMismatch: "供应商延迟或市场覆盖条件不一致，因此暂不显示相对差值。",
    staleComparison: "至少一项观测已过期或不是当前数据。",
    providerUnavailable: "所需的供应商观测不可用。",
    fixtureSuppressed: "走势透镜绝不会使用示例数据。",
    latestEvidence: "最新相关证据",
    evidenceLoading: "正在核查当前相关证据。",
    evidenceUnavailable: "无法验证当前相关证据。",
    noEvidenceTitle: "暂无当前相关证据",
    noEvidenceBody: "当前没有与所选股票相关的非示例供应商事件。",
    openSource: "打开来源",
    sourceUnavailable: "来源链接不可用",
    controversy: "争议性事件",
    originalLanguage: "来源文字保留原始语言。",
    providerObservation: (value) => `供应商观测时间 ${value}`,
    providerAndTime: (provider, value) => `${provider} · ${value}`,
    delayed: (minutes) => `延迟 ${minutes} 分钟`,
    limitedCoverage: "有限交易所覆盖",
    consolidatedCoverage: "综合市场覆盖",
    timestampUnavailable: "时间不可用",
    disclosure: "相对走势与同期证据只提供相关性和背景，并不能证明因果关系。",
    cardAria: (ticker) => `${ticker} 走势透镜`,
    moveAria: (ticker, value) => `${ticker} 当日走势 ${value}`,
    gapAria: (ticker, proxy, value) =>
      `${ticker} 相对 ${proxy} 的差值为 ${value} 个百分点`,
    category: categoryZh,
    claimStatus: {
      confirmed: "已确认",
      "official-investigation": "正式调查",
      reported: "已报道",
      allegation: "指控",
      disputed: "存在争议",
      corrected: "已修正",
    },
    causalLink: {
      supported: "有证据支持的影响因素",
      "plausible-contributor": "可能的影响因素",
      "temporal-only": "仅时间上重合",
      unassessed: "因果关系尚未评估",
    },
    benchmarkLabels: {
      spy: "标普 500 ETF 代理",
      qqq: "纳斯达克 100 ETF 代理",
    },
  },
};
