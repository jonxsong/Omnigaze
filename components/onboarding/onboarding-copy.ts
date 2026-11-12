import type { AppLocale } from "@/lib/app-locale";
import type {
  OnboardingGoal,
  OnboardingHorizon,
  OnboardingLiquidityNeed,
  OnboardingRiskProfile,
} from "@/lib/onboarding-draft";

interface StepCopy {
  eyebrow: string;
  title: string;
  shortTitle: string;
  description: string;
}

interface DetailedOption<T> {
  value: T;
  label: string;
  detail: string;
}

interface SimpleOption<T> {
  value: T;
  label: string;
}

export interface OnboardingCopy {
  pageTitle: string;
  locale: { group: string; english: string; chinese: string };
  steps: readonly StepCopy[];
  goals: readonly DetailedOption<OnboardingGoal>[];
  horizons: readonly SimpleOption<OnboardingHorizon>[];
  risks: readonly DetailedOption<OnboardingRiskProfile>[];
  liquidity: readonly SimpleOption<OnboardingLiquidityNeed>[];
  preview: {
    aria: string;
    eyebrow: string;
    title: string;
    watchlist: string;
    owned: string;
    empty: string;
    researchHorizon: string;
    notSet: string;
    holdingsAdded: string;
    researchLens: string;
    emptyLens: string;
    trustTitle: string;
    trustBody: string;
  };
  search: {
    placeholder: string;
    aria: string;
    note: string;
    searching: string;
    stale: string;
    errorAlert: string;
    selected: string;
    selectedCount: (count: number) => string;
    remove: (ticker: string) => string;
    matchesAria: string;
    featuredAria: string;
    searchingTitle: string;
    searchingBody: string;
    unavailableTitle: string;
    unavailableBody: string;
    noMatchTitle: string;
    noMatchBody: string;
  };
  holdings: {
    privacyTitle: string;
    privacyBody: string;
    owned: string;
    watchOnly: string;
    shares: string;
    required: string;
    averageCost: string;
    optional: string;
    contextNote: string;
  };
  preferences: {
    goalsLegend: string;
    chooseUpToThree: string;
    horizonLegend: string;
    horizonPrompt: string;
    riskLegend: string;
    riskPrompt: string;
    liquidityLegend: string;
    liquidityPrompt: string;
    boundaryTitle: string;
    boundaryBody: string;
  };
  review: {
    complete: string;
    title: (count: number) => string;
    body: string;
    watchlist: string;
    holdings: string;
    priorities: string;
    edit: string;
    position: (shares: string, averageCost: string) => string;
    noPositions: string;
    neutral: string;
    goals: string;
    horizon: string;
    risk: string;
    liquidity: string;
    authenticatedTitle: string;
    localTitle: string;
    authenticatedBody: string;
    localBody: string;
    accountBadge: string;
    localBadge: string;
  };
  validation: {
    stocks: string;
    shares: (ticker: string) => string;
    averageCost: (ticker: string) => string;
    goals: string;
    horizon: string;
    risk: string;
    liquidity: string;
    syncFailed: string;
    saveFailed: string;
  };
  chrome: {
    homeAria: string;
    alpha: string;
    progress: (current: number, total: number) => string;
    progressAria: (current: number, total: number) => string;
    restoring: string;
    saving: string;
    saveError: string;
    saved: string;
    exit: string;
    railAria: string;
    railEyebrow: string;
    localTitle: string;
    localBody: string;
  };
  actions: {
    back: string;
    skipSetup: string;
    skipHoldings: string;
    neutralDefaults: string;
    continue: string;
    buildDashboard: string;
  };
  loading: { title: string; subtitle: string };
}

export const onboardingCopy = {
  en: {
    pageTitle: "Personalize your market — Omnigaze",
    locale: {
      group: "Onboarding language",
      english: "English",
      chinese: "中文",
    },
    steps: [
      {
        eyebrow: "YOUR MARKET",
        title: "Choose the stocks that matter to you",
        shortTitle: "Stocks",
        description:
          "Start with a focused watchlist. You can add or remove companies any time from the dashboard.",
      },
      {
        eyebrow: "YOUR CONTEXT",
        title: "Which of these do you own?",
        shortTitle: "Holdings",
        description:
          "Position details help Omnigaze frame concentration and exposure. They never authorize trades.",
      },
      {
        eyebrow: "YOUR PRIORITIES",
        title: "What should Omnigaze prioritize?",
        shortTitle: "Preferences",
        description:
          "Set the research lens for your feed. These choices rank context; they do not create trade recommendations.",
      },
      {
        eyebrow: "READY TO GO",
        title: "Your market, ready",
        shortTitle: "Review",
        description:
          "Review what will shape your workspace, then open your personalized dashboard.",
      },
    ],
    goals: [
      {
        value: "material-changes",
        label: "Stay ahead of material changes",
        detail: "Prioritize filings, guidance, and events that change the picture.",
      },
      {
        value: "downside-risk",
        label: "Monitor downside risk",
        detail: "Bring emerging contradictions and governance risks forward.",
      },
      {
        value: "long-term-thesis",
        label: "Track a long-term thesis",
        detail: "Connect new evidence to the durable drivers you care about.",
      },
      {
        value: "earnings-prep",
        label: "Prepare for earnings",
        detail: "Surface expectations, changes, and unresolved questions.",
      },
      {
        value: "portfolio-context",
        label: "Understand portfolio context",
        detail: "Keep concentration and cross-company signals visible.",
      },
    ],
    horizons: [
      { value: "days-weeks", label: "Days to weeks" },
      { value: "months", label: "Several months" },
      { value: "one-three-years", label: "1–3 years" },
      { value: "three-plus-years", label: "3+ years" },
    ],
    risks: [
      {
        value: "early-warning",
        label: "Early warning",
        detail: "Show meaningful risks while evidence is still developing.",
      },
      {
        value: "balanced",
        label: "Balanced",
        detail: "Balance emerging signals with confirmed material changes.",
      },
      {
        value: "material-only",
        label: "Material changes only",
        detail: "Keep attention on the highest-consequence developments.",
      },
      {
        value: "prefer-not-to-say",
        label: "Prefer not to say",
        detail: "Use Omnigaze's neutral materiality-first ranking.",
      },
    ],
    liquidity: [
      { value: "none-near-term", label: "No expected near-term need" },
      { value: "within-twelve-months", label: "Possible need within 12 months" },
      { value: "ongoing", label: "Ongoing liquidity needs" },
      { value: "prefer-not-to-say", label: "Prefer not to say" },
    ],
    preview: {
      aria: "Personalization preview",
      eyebrow: "PERSONALIZATION PREVIEW",
      title: "Your Omnigaze workspace",
      watchlist: "WATCHLIST",
      owned: "OWNED",
      empty: "Your selected companies will appear here.",
      researchHorizon: "Research horizon",
      notSet: "Not set",
      holdingsAdded: "Holdings added",
      researchLens: "YOUR RESEARCH LENS",
      emptyLens: "Choose goals to explain why an event is relevant to you.",
      trustTitle: "Transparent by default",
      trustBody:
        "Source, freshness, and demo labels remain visible after personalization.",
    },
    search: {
      placeholder: "Search any active U.S. stock",
      aria: "Search active U.S. stocks",
      note: "Search the active U.S. equity catalog. Featured companies appear before you type; no brokerage connection is required.",
      searching: "Searching the live asset catalog…",
      stale: "Catalog refresh is delayed; showing the latest verified cached matches.",
      errorAlert:
        "Stock search is temporarily unavailable. Your selected companies are still saved.",
      selected: "SELECTED",
      selectedCount: (count) => `${count} stocks`,
      remove: (ticker) => `Remove ${ticker}`,
      matchesAria: "Asset catalog matches",
      featuredAria: "Featured stocks",
      searchingTitle: "Searching the catalog",
      searchingBody: "Checking active U.S. equities.",
      unavailableTitle: "Catalog unavailable",
      unavailableBody: "Try again shortly; your draft is unchanged.",
      noMatchTitle: "No active U.S. equity match",
      noMatchBody: "Try the full ticker or company name.",
    },
    holdings: {
      privacyTitle: "Private, optional context",
      privacyBody:
        "Saved only in this browser during the anonymous alpha. Omnigaze cannot place trades.",
      owned: "I own this",
      watchOnly: "Watch only",
      shares: "Shares",
      required: "Required",
      averageCost: "Average cost per share",
      optional: "Optional",
      contextNote:
        "Cost basis is used only for position context. Demo prices will never be presented as real portfolio value or profit and loss.",
    },
    preferences: {
      goalsLegend: "What brings you back to the market?",
      chooseUpToThree: "Choose up to three",
      horizonLegend: "Research horizon",
      horizonPrompt: "Which time frame should contextualize new evidence?",
      riskLegend: "Risk sensitivity",
      riskPrompt: "How early should developing risk appear in your feed?",
      liquidityLegend: "Liquidity preference",
      liquidityPrompt: "Optional context for prioritizing near-term risks.",
      boundaryTitle: "Research support, not financial advice.",
      boundaryBody:
        "These answers tune ranking and explanation. They never trigger a trade or turn an inference into a fact.",
    },
    review: {
      complete: "SETUP COMPLETE",
      title: (count) => `${count} stocks, one focused market view`,
      body: "Omnigaze will use this context to organize evidence—not to make decisions for you.",
      watchlist: "Watchlist",
      holdings: "Holdings",
      priorities: "Research priorities",
      edit: "Edit",
      position: (shares, averageCost) =>
        `${shares} shares${averageCost ? ` · $${averageCost} avg.` : ""}`,
      noPositions: "No position details added.",
      neutral: "Neutral, materiality-first ranking.",
      goals: "Goals",
      horizon: "Horizon",
      risk: "Risk",
      liquidity: "Liquidity",
      authenticatedTitle: "Ready to sync safely",
      localTitle: "Saved on this device",
      authenticatedBody:
        "Completing setup adds these stocks and new positions to your account. Existing watchlists and holdings are preserved; research preferences stay on this device for now.",
      localBody:
        "This anonymous alpha stores setup in your browser. You can sign in from the dashboard to sync the watchlist across devices.",
      accountBadge: "ACCOUNT",
      localBadge: "LOCAL",
    },
    validation: {
      stocks: "Choose at least one stock to personalize your dashboard.",
      shares: (ticker) => `Enter a share quantity for ${ticker}.`,
      averageCost: (ticker) =>
        `Enter a valid average cost for ${ticker}, or leave it blank.`,
      goals: "Choose at least one research goal.",
      horizon: "Choose a research horizon.",
      risk: "Choose a risk sensitivity.",
      liquidity: "Choose a liquidity preference.",
      syncFailed:
        "Account setup could not be synced. Your existing account data was not replaced; retrying is safe.",
      saveFailed:
        "We could not save this setup. Your existing account data was not replaced; retrying is safe.",
    },
    chrome: {
      homeAria: "Omnigaze home",
      alpha: "ALPHA",
      progress: (current, total) => `Step ${current} of ${total}`,
      progressAria: (current, total) => `Step ${current} of ${total}`,
      restoring: "Restoring",
      saving: "Saving",
      saveError: "Local save unavailable",
      saved: "Saved on this device",
      exit: "Exit setup",
      railAria: "Onboarding progress",
      railEyebrow: "PERSONALIZE OMNIGAZE",
      localTitle: "Local by default",
      localBody: "Setup stays in this browser.",
    },
    actions: {
      back: "Back",
      skipSetup: "Skip setup for now",
      skipHoldings: "Skip holdings",
      neutralDefaults: "Use neutral defaults",
      continue: "Continue",
      buildDashboard: "Build my dashboard",
    },
    loading: {
      title: "Restoring your Omnigaze setup",
      subtitle: "Saved only on this device",
    },
  },
  "zh-CN": {
    pageTitle: "个性化你的市场 — Omnigaze",
    locale: {
      group: "引导流程语言",
      english: "English",
      chinese: "中文",
    },
    steps: [
      {
        eyebrow: "你的市场",
        title: "选择你真正关心的股票",
        shortTitle: "股票",
        description:
          "从精简的关注列表开始。你可以随时在仪表盘中添加或移除公司。",
      },
      {
        eyebrow: "你的持仓背景",
        title: "其中哪些是你持有的？",
        shortTitle: "持仓",
        description:
          "持仓信息帮助 Omnigaze 理解集中度和风险敞口，但绝不会授权任何交易。",
      },
      {
        eyebrow: "你的优先级",
        title: "希望 Omnigaze 优先关注什么？",
        shortTitle: "偏好",
        description:
          "为信息流设置研究视角。这些选择只会调整背景排序，不会生成交易建议。",
      },
      {
        eyebrow: "准备就绪",
        title: "你的市场视图已准备好",
        shortTitle: "确认",
        description:
          "确认将用于塑造工作区的信息，然后打开你的个性化仪表盘。",
      },
    ],
    goals: [
      {
        value: "material-changes",
        label: "提前掌握重大变化",
        detail: "优先呈现会改变判断的公告、指引和事件。",
      },
      {
        value: "downside-risk",
        label: "关注下行风险",
        detail: "更早呈现正在浮现的矛盾与治理风险。",
      },
      {
        value: "long-term-thesis",
        label: "跟踪长期投资逻辑",
        detail: "把新证据与你关心的长期驱动因素联系起来。",
      },
      {
        value: "earnings-prep",
        label: "为财报做准备",
        detail: "呈现市场预期、变化和仍未解决的问题。",
      },
      {
        value: "portfolio-context",
        label: "理解投资组合背景",
        detail: "持续关注集中度和跨公司的关联信号。",
      },
    ],
    horizons: [
      { value: "days-weeks", label: "几天到几周" },
      { value: "months", label: "数月" },
      { value: "one-three-years", label: "1–3 年" },
      { value: "three-plus-years", label: "3 年以上" },
    ],
    risks: [
      {
        value: "early-warning",
        label: "早期预警",
        detail: "在证据仍在发展时就显示有意义的风险。",
      },
      {
        value: "balanced",
        label: "平衡",
        detail: "兼顾新出现的信号与已确认的重大变化。",
      },
      {
        value: "material-only",
        label: "仅重大变化",
        detail: "把注意力集中在影响最重大的进展上。",
      },
      {
        value: "prefer-not-to-say",
        label: "暂不回答",
        detail: "使用 Omnigaze 中性、重大性优先的排序。",
      },
    ],
    liquidity: [
      { value: "none-near-term", label: "近期暂无预期需求" },
      { value: "within-twelve-months", label: "未来 12 个月内可能有需求" },
      { value: "ongoing", label: "有持续的流动性需求" },
      { value: "prefer-not-to-say", label: "暂不回答" },
    ],
    preview: {
      aria: "个性化预览",
      eyebrow: "个性化预览",
      title: "你的 Omnigaze 工作区",
      watchlist: "关注列表",
      owned: "已持有",
      empty: "你选择的公司会显示在这里。",
      researchHorizon: "研究周期",
      notSet: "未设置",
      holdingsAdded: "已添加持仓",
      researchLens: "你的研究视角",
      emptyLens: "选择研究目标，说明某个事件为什么与你相关。",
      trustTitle: "默认保持透明",
      trustBody: "个性化后仍会清楚标注来源、信息时效和演示数据。",
    },
    search: {
      placeholder: "搜索任意活跃的美国股票",
      aria: "搜索活跃的美国股票",
      note: "搜索活跃的美国股票目录。输入前会显示精选公司，无需连接券商账户。",
      searching: "正在搜索实时股票目录…",
      stale: "目录刷新延迟；正在显示最新已验证的缓存结果。",
      errorAlert: "股票搜索暂时不可用。你已选择的公司仍已保存。",
      selected: "已选择",
      selectedCount: (count) => `${count} 只股票`,
      remove: (ticker) => `移除 ${ticker}`,
      matchesAria: "股票目录匹配结果",
      featuredAria: "精选股票",
      searchingTitle: "正在搜索股票目录",
      searchingBody: "正在核对活跃的美国股票。",
      unavailableTitle: "股票目录不可用",
      unavailableBody: "请稍后重试；你的设置草稿未改变。",
      noMatchTitle: "未找到匹配的活跃美国股票",
      noMatchBody: "请尝试完整股票代码或公司名称。",
    },
    holdings: {
      privacyTitle: "私密、可选的背景信息",
      privacyBody:
        "匿名 Alpha 阶段仅保存在此浏览器中。Omnigaze 无法替你下单。",
      owned: "我持有这只股票",
      watchOnly: "仅关注",
      shares: "股数",
      required: "必填",
      averageCost: "每股平均成本",
      optional: "选填",
      contextNote:
        "成本基础仅用于持仓背景。演示价格绝不会被当作真实投资组合价值或盈亏。",
    },
    preferences: {
      goalsLegend: "什么会让你持续关注市场？",
      chooseUpToThree: "最多选择三项",
      horizonLegend: "研究周期",
      horizonPrompt: "希望用哪个时间范围理解新证据？",
      riskLegend: "风险敏感度",
      riskPrompt: "希望多早在信息流中看到正在发展的风险？",
      liquidityLegend: "流动性偏好",
      liquidityPrompt: "用于优先考虑近期风险的可选背景。",
      boundaryTitle: "研究辅助，不构成财务建议。",
      boundaryBody:
        "这些答案只会调整排序和解释，不会触发交易，也不会把推断变成事实。",
    },
    review: {
      complete: "设置完成",
      title: (count) => `${count} 只股票，一个聚焦的市场视图`,
      body: "Omnigaze 会用这些背景整理证据，而不会替你做决定。",
      watchlist: "关注列表",
      holdings: "持仓",
      priorities: "研究优先级",
      edit: "编辑",
      position: (shares, averageCost) =>
        `${shares} 股${averageCost ? ` · 平均成本 $${averageCost}` : ""}`,
      noPositions: "尚未添加持仓详情。",
      neutral: "中性、重大性优先的排序。",
      goals: "目标",
      horizon: "周期",
      risk: "风险",
      liquidity: "流动性",
      authenticatedTitle: "已准备好安全同步",
      localTitle: "已保存在此设备",
      authenticatedBody:
        "完成设置后，这些股票和新持仓会添加到你的账户。现有关注列表和持仓会保留；研究偏好目前仍保存在此设备。",
      localBody:
        "匿名 Alpha 会把设置保存在此浏览器中。你可以从仪表盘登录，以便跨设备同步关注列表。",
      accountBadge: "账户",
      localBadge: "本地",
    },
    validation: {
      stocks: "请至少选择一只股票，以个性化你的仪表盘。",
      shares: (ticker) => `请输入 ${ticker} 的持股数量。`,
      averageCost: (ticker) =>
        `请输入 ${ticker} 的有效平均成本，或将其留空。`,
      goals: "请至少选择一个研究目标。",
      horizon: "请选择研究周期。",
      risk: "请选择风险敏感度。",
      liquidity: "请选择流动性偏好。",
      syncFailed:
        "无法同步账户设置。现有账户数据未被替换；你可以安全重试。",
      saveFailed:
        "无法保存此设置。现有账户数据未被替换；你可以安全重试。",
    },
    chrome: {
      homeAria: "Omnigaze 首页",
      alpha: "ALPHA",
      progress: (current, total) => `第 ${current} 步，共 ${total} 步`,
      progressAria: (current, total) => `第 ${current} 步，共 ${total} 步`,
      restoring: "正在恢复",
      saving: "正在保存",
      saveError: "无法在本地保存",
      saved: "已保存在此设备",
      exit: "退出设置",
      railAria: "引导进度",
      railEyebrow: "个性化 OMNIGAZE",
      localTitle: "默认本地保存",
      localBody: "设置保留在此浏览器中。",
    },
    actions: {
      back: "返回",
      skipSetup: "暂时跳过设置",
      skipHoldings: "跳过持仓",
      neutralDefaults: "使用中性默认值",
      continue: "继续",
      buildDashboard: "创建我的仪表盘",
    },
    loading: {
      title: "正在恢复你的 Omnigaze 设置",
      subtitle: "仅保存在此设备",
    },
  },
} satisfies Record<AppLocale, OnboardingCopy>;
