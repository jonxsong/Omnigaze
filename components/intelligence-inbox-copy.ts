import type { AppLocale } from "@/lib/app-locale";
import type {
  ClaimStatus,
  IntelligenceEvent,
  Materiality,
} from "@/lib/market-types";

type InboxCategory = IntelligenceEvent["category"];

interface IntelligenceInboxCopy {
  time: {
    unavailable: string;
    justNow: string;
    minutesAgo(value: number): string;
    hoursAgo(value: number): string;
  };
  materiality: Record<Materiality, string>;
  category: Record<InboxCategory, string>;
  claimStatus: Record<ClaimStatus, string>;
  market: string;
  errors: {
    inboxRefresh(status: number): string;
    inboxInvalid: string;
    inboxDelayed: string;
    inboxUnavailable: string;
    savedRefresh(status: number): string;
    savedInvalid: string;
    savedDelayed: string;
    savedUnavailable: string;
    itemLookup(status: number): string;
    itemInvalid: string;
    itemUnavailable: string;
    rulesRefresh(status: number): string;
    rulesInvalid: string;
    rulesUnavailable: string;
    inboxUpdate(status: number): string;
    inboxUpdateInvalid: string;
    inboxUpdateFailed: string;
    ruleUpdate(status: number): string;
    ruleUpdateInvalid: string;
    ruleUpdateFailed: string;
  };
  conflict: {
    inboxReloaded: string;
    inboxRollback: string;
    ruleReloaded: string;
    ruleRollback: string;
    accountReloaded(message: string): string;
    accountUnverified(message: string): string;
    ruleStateReloaded(message: string): string;
    ruleStateUnverified(message: string): string;
  };
  saveFlow: {
    signIn: string;
    nothingSaved(message: string): string;
    ineligible: string;
    alreadySaved: string;
    saved: string;
  };
  sync: {
    catchingUp: string;
    liveComplete: string;
    recentReused: string;
    addStocks: string;
    stored: string;
    unavailable: string;
  };
  header: {
    eyebrow: string;
    title: string;
    description: string;
    refreshAria: string;
    closeAria: string;
  };
  auth: {
    eyebrow: string;
    title: string;
    body: string;
    action: string;
    note: string;
  };
  tabs: {
    aria: string;
    inbox: string;
    inboxUnread(count: number): string;
    saved: string;
    rules: string;
  };
  filters: {
    aria: string;
    all: string;
    unread: string;
    alerts: string;
    highImpact: string;
  };
  storedRulesVisible: string;
  storedInboxVisible: string;
  finishingSave: string;
  footerSafety: string;
  loading: {
    title: string;
    body: string;
  };
  empty: {
    watchlist: readonly [string, string];
    saved: readonly [string, string];
    unread: readonly [string, string];
    alerts: readonly [string, string];
    highImpact: readonly [string, string];
    provider: readonly [string, string];
  };
  event: {
    unreadAria: string;
    ruleMatch: string;
    controversy: string;
    updatedSinceRead: string;
    providerUpdate: string;
    openSource: string;
    sourceUnavailable: string;
    markRead: string;
    markUnread: string;
    saved: string;
    saveForThesis: string;
    restore: string;
    dismiss: string;
    savingAria: string;
  };
  rules: {
    deliveryTitle: string;
    deliveryBody: string;
    eyebrow: string;
    title: string;
    intro: string;
    emptyTitle: string;
    emptyBody: string;
    enableAria(ticker: string): string;
    on: string;
    off: string;
    minimumImpact: string;
    mediumOrHigher: string;
    highOrCritical: string;
    criticalOnly: string;
    includeControversy: string;
    controversyHelp: string;
    saving: string;
  };
}

export const intelligenceInboxCopy = {
  en: {
    time: {
      unavailable: "Time unavailable",
      justNow: "Just now",
      minutesAgo: (value) => `${value}m ago`,
      hoursAgo: (value) => `${value}h ago`,
    },
    materiality: {
      low: "Low impact",
      medium: "Medium impact",
      high: "High impact",
      critical: "Critical impact",
    },
    category: {
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
    },
    claimStatus: {
      confirmed: "Confirmed",
      "official-investigation": "Official investigation",
      reported: "Reported",
      allegation: "Allegation",
      disputed: "Disputed",
      corrected: "Corrected",
    },
    market: "Market",
    errors: {
      inboxRefresh: (status) => `Inbox refresh failed with ${status}.`,
      inboxInvalid: "The intelligence inbox returned an invalid response.",
      inboxDelayed:
        "Live provider refresh is delayed. Stored account events remain available.",
      inboxUnavailable: "The intelligence inbox is temporarily unavailable.",
      savedRefresh: (status) =>
        `Saved intelligence refresh failed with ${status}.`,
      savedInvalid: "Saved intelligence returned an invalid response.",
      savedDelayed:
        "Live provider refresh is delayed. Stored saved intelligence remains available.",
      savedUnavailable: "Saved intelligence is temporarily unavailable.",
      itemLookup: (status) => `Inbox item lookup failed with ${status}.`,
      itemInvalid: "The inbox item lookup returned an invalid response.",
      itemUnavailable: "The durable inbox item could not be loaded.",
      rulesRefresh: (status) => `Alert rules refresh failed with ${status}.`,
      rulesInvalid: "The alert rules endpoint returned an invalid response.",
      rulesUnavailable: "Alert rules are temporarily unavailable.",
      inboxUpdate: (status) => `Inbox update failed with ${status}.`,
      inboxUpdateInvalid: "The inbox update returned an invalid response.",
      inboxUpdateFailed: "Inbox update failed.",
      ruleUpdate: (status) => `Alert rule update failed with ${status}.`,
      ruleUpdateInvalid: "The alert rule update returned an invalid response.",
      ruleUpdateFailed: "Alert rule update failed.",
    },
    conflict: {
      inboxReloaded:
        "This event changed in another session. Omnigaze loaded the latest account state.",
      inboxRollback:
        "This event changed in another session. Your optimistic change was rolled back, but the latest account state could not be loaded.",
      ruleReloaded:
        "This rule changed in another session. Omnigaze loaded the latest version.",
      ruleRollback:
        "This rule changed in another session. Your optimistic change was rolled back, but the latest rule could not be loaded.",
      accountReloaded: (message) =>
        `${message} Omnigaze loaded the latest account state.`,
      accountUnverified: (message) =>
        `${message} The latest account state could not be verified; the optimistic view was rolled back.`,
      ruleStateReloaded: (message) =>
        `${message} Omnigaze loaded the latest rule state.`,
      ruleStateUnverified: (message) =>
        `${message} The latest rule state could not be verified; the optimistic view was rolled back.`,
    },
    saveFlow: {
      signIn: "Sign in before saving intelligence to your thesis.",
      nothingSaved: (message) => `${message} Nothing was saved.`,
      ineligible:
        "This event is not eligible for durable saving. Demo, stale, and unverified feed items are never added to your account inbox.",
      alreadySaved: "This event is already saved in your thesis workspace.",
      saved: "Saved to your thesis workspace.",
    },
    sync: {
      catchingUp: "Catching up on fresh evidence",
      liveComplete: "Live provider check complete",
      recentReused: "Recent provider check reused",
      addStocks: "Add stocks to begin monitoring",
      stored: "Showing stored account intelligence",
      unavailable: "Live provider refresh unavailable",
    },
    header: {
      eyebrow: "PERSONAL MARKET INTELLIGENCE",
      title: "Intelligence inbox",
      description: "Evidence that matters to the stocks you follow.",
      refreshAria: "Refresh intelligence inbox",
      closeAria: "Close intelligence inbox",
    },
    auth: {
      eyebrow: "YOUR PRIVATE WORKSPACE",
      title: "Sign in to keep your intelligence",
      body:
        "Read state, saved research, and alert rules belong to your account and stay synchronized across your Omnigaze sessions.",
      action: "Sign in to continue",
      note:
        "Omnigaze does not create background alerts or store inbox activity while you are signed out.",
    },
    tabs: {
      aria: "Intelligence inbox views",
      inbox: "Inbox",
      inboxUnread: (count) => `Inbox, ${count} unread`,
      saved: "Saved",
      rules: "Rules",
    },
    filters: {
      aria: "Filter intelligence",
      all: "All",
      unread: "Unread",
      alerts: "Alerts",
      highImpact: "High impact",
    },
    storedRulesVisible: "Stored alert rules remain visible.",
    storedInboxVisible: "Stored inbox events remain visible.",
    finishingSave: "Finishing the durable refresh before saving…",
    footerSafety:
      "Live, fresh evidence only. Demo and stale items never create alerts.",
    loading: {
      title: "Checking your market intelligence",
      body: "Matching fresh provider evidence to your watchlist…",
    },
    empty: {
      watchlist: [
        "Your inbox starts with a watchlist",
        "Add a stock and Omnigaze will check fresh provider evidence when you return.",
      ],
      saved: [
        "No saved research yet",
        "Save an event to keep it available for your thesis, even after it leaves the recent feed.",
      ],
      unread: [
        "You are caught up",
        "There are no unread intelligence events in your account.",
      ],
      alerts: [
        "No matching alerts",
        "Alert rules are opt-in. Enable one in Rules to surface matching fresh evidence here.",
      ],
      highImpact: [
        "No high-impact events",
        "No stored events currently meet the high or critical impact filter.",
      ],
      provider: [
        "No provider events yet",
        "Omnigaze will keep checking for live, fresh evidence tied to your watchlist.",
      ],
    },
    event: {
      unreadAria: "Unread",
      ruleMatch: "Rule match",
      controversy: "Controversy",
      updatedSinceRead: "Updated since read",
      providerUpdate: "Provider update",
      openSource: "Open source",
      sourceUnavailable: "Source link unavailable",
      markRead: "Mark read",
      markUnread: "Mark unread",
      saved: "Saved",
      saveForThesis: "Save for thesis",
      restore: "Restore",
      dismiss: "Dismiss",
      savingAria: "Saving",
    },
    rules: {
      deliveryTitle: "In-app only",
      deliveryBody:
        "Matching evidence appears in Omnigaze when it becomes available and when you next open the app. Email, SMS, push, and browser notifications are not enabled.",
      eyebrow: "WATCHLIST RULES",
      title: "Choose what earns your attention",
      intro:
        "Rules are off by default and are never inferred from onboarding answers.",
      emptyTitle: "Add a stock before creating a rule",
      emptyBody: "Each alert rule is scoped to one symbol on your watchlist.",
      enableAria: (ticker) => `Enable ${ticker} in-app alert rule`,
      on: "On",
      off: "Off",
      minimumImpact: "Minimum impact",
      mediumOrHigher: "Medium or higher",
      highOrCritical: "High or critical",
      criticalOnly: "Critical only",
      includeControversy: "Include controversy",
      controversyHelp:
        "Reported disputes, allegations, and reputation events.",
      saving: "Saving rule…",
    },
  },
  "zh-CN": {
    time: {
      unavailable: "时间不可用",
      justNow: "刚刚",
      minutesAgo: (value) => `${value} 分钟前`,
      hoursAgo: (value) => `${value} 小时前`,
    },
    materiality: {
      low: "低影响",
      medium: "中等影响",
      high: "高影响",
      critical: "重大影响",
    },
    category: {
      earnings: "财报",
      filing: "监管文件",
      macro: "宏观",
      market: "市场",
      product: "产品",
      governance: "公司治理",
      executive: "高管",
      legal: "法律",
      regulatory: "监管",
      reputation: "声誉",
      geopolitical: "地缘政治",
    },
    claimStatus: {
      confirmed: "已确认",
      "official-investigation": "官方调查中",
      reported: "媒体报道",
      allegation: "指控",
      disputed: "存在争议",
      corrected: "已更正",
    },
    market: "市场",
    errors: {
      inboxRefresh: (status) => `情报收件箱刷新失败（${status}）。`,
      inboxInvalid: "情报收件箱返回了无效响应。",
      inboxDelayed: "实时数据源刷新延迟，已保存的账户事件仍可查看。",
      inboxUnavailable: "情报收件箱暂时不可用。",
      savedRefresh: (status) => `已保存情报刷新失败（${status}）。`,
      savedInvalid: "已保存情报返回了无效响应。",
      savedDelayed: "实时数据源刷新延迟，已保存的研究仍可查看。",
      savedUnavailable: "已保存情报暂时不可用。",
      itemLookup: (status) => `情报项目读取失败（${status}）。`,
      itemInvalid: "情报项目读取返回了无效响应。",
      itemUnavailable: "无法加载持久化的情报项目。",
      rulesRefresh: (status) => `提醒规则刷新失败（${status}）。`,
      rulesInvalid: "提醒规则接口返回了无效响应。",
      rulesUnavailable: "提醒规则暂时不可用。",
      inboxUpdate: (status) => `收件箱更新失败（${status}）。`,
      inboxUpdateInvalid: "收件箱更新返回了无效响应。",
      inboxUpdateFailed: "收件箱更新失败。",
      ruleUpdate: (status) => `提醒规则更新失败（${status}）。`,
      ruleUpdateInvalid: "提醒规则更新返回了无效响应。",
      ruleUpdateFailed: "提醒规则更新失败。",
    },
    conflict: {
      inboxReloaded: "此事件已在另一个会话中更改。Omnigaze 已加载最新账户状态。",
      inboxRollback:
        "此事件已在另一个会话中更改。临时更改已撤回，但无法加载最新账户状态。",
      ruleReloaded: "此规则已在另一个会话中更改。Omnigaze 已加载最新版本。",
      ruleRollback:
        "此规则已在另一个会话中更改。临时更改已撤回，但无法加载最新规则。",
      accountReloaded: (message) => `${message} Omnigaze 已加载最新账户状态。`,
      accountUnverified: (message) =>
        `${message} 无法核验最新账户状态；临时显示已撤回。`,
      ruleStateReloaded: (message) => `${message} Omnigaze 已加载最新规则状态。`,
      ruleStateUnverified: (message) =>
        `${message} 无法核验最新规则状态；临时显示已撤回。`,
    },
    saveFlow: {
      signIn: "请先登录，再将情报保存到研究主题。",
      nothingSaved: (message) => `${message} 未保存任何内容。`,
      ineligible:
        "此事件不符合持久化保存条件。演示、过期或未核验的内容不会加入账户收件箱。",
      alreadySaved: "此事件已保存在你的研究工作区中。",
      saved: "已保存到你的研究工作区。",
    },
    sync: {
      catchingUp: "正在补充最新证据",
      liveComplete: "实时数据源检查完成",
      recentReused: "已复用最近的数据源检查",
      addStocks: "添加股票以开始监控",
      stored: "正在显示已保存的账户情报",
      unavailable: "实时数据源刷新不可用",
    },
    header: {
      eyebrow: "个人市场情报",
      title: "情报收件箱",
      description: "与你关注的股票密切相关的证据。",
      refreshAria: "刷新情报收件箱",
      closeAria: "关闭情报收件箱",
    },
    auth: {
      eyebrow: "你的私人工作区",
      title: "登录以保存你的情报",
      body:
        "阅读状态、已保存研究和提醒规则均归属于你的账户，并会在 Omnigaze 会话之间同步。",
      action: "登录并继续",
      note: "退出登录时，Omnigaze 不会创建后台提醒或存储收件箱活动。",
    },
    tabs: {
      aria: "情报收件箱视图",
      inbox: "收件箱",
      inboxUnread: (count) => `收件箱，${count} 条未读`,
      saved: "已保存",
      rules: "规则",
    },
    filters: {
      aria: "筛选情报",
      all: "全部",
      unread: "未读",
      alerts: "提醒",
      highImpact: "高影响",
    },
    storedRulesVisible: "已保存的提醒规则仍可查看。",
    storedInboxVisible: "已保存的收件箱事件仍可查看。",
    finishingSave: "正在完成持久化刷新后再保存…",
    footerSafety: "仅使用实时且新鲜的证据。演示和过期内容绝不会触发提醒。",
    loading: {
      title: "正在检查你的市场情报",
      body: "正在将最新数据源证据与你的自选股匹配…",
    },
    empty: {
      watchlist: [
        "先从自选股开始建立收件箱",
        "添加股票后，Omnigaze 会在你返回时检查最新的数据源证据。",
      ],
      saved: [
        "尚无已保存研究",
        "保存事件后，即使它离开近期动态，也能继续用于你的研究主题。",
      ],
      unread: ["你已全部读完", "你的账户中没有未读情报事件。"],
      alerts: [
        "没有匹配的提醒",
        "提醒规则需主动开启。请在“规则”中启用，以在此显示匹配的最新证据。",
      ],
      highImpact: [
        "没有高影响事件",
        "当前没有已保存事件符合高影响或重大影响筛选条件。",
      ],
      provider: [
        "暂无数据源事件",
        "Omnigaze 会继续检查与你的自选股相关的实时最新证据。",
      ],
    },
    event: {
      unreadAria: "未读",
      ruleMatch: "规则匹配",
      controversy: "争议事件",
      updatedSinceRead: "阅读后有更新",
      providerUpdate: "数据源更新",
      openSource: "打开来源",
      sourceUnavailable: "来源链接不可用",
      markRead: "标为已读",
      markUnread: "标为未读",
      saved: "已保存",
      saveForThesis: "保存到研究主题",
      restore: "恢复",
      dismiss: "忽略",
      savingAria: "正在保存",
    },
    rules: {
      deliveryTitle: "仅应用内提醒",
      deliveryBody:
        "匹配证据可用时，以及你下次打开应用时，会显示在 Omnigaze 中。目前未启用电子邮件、短信、推送或浏览器通知。",
      eyebrow: "自选股规则",
      title: "选择真正值得关注的变化",
      intro: "规则默认关闭，也绝不会根据引导问卷答案自动推断。",
      emptyTitle: "请先添加股票，再创建规则",
      emptyBody: "每条提醒规则仅对应自选股中的一个股票代码。",
      enableAria: (ticker) => `启用 ${ticker} 应用内提醒规则`,
      on: "开启",
      off: "关闭",
      minimumImpact: "最低影响级别",
      mediumOrHigher: "中等或更高",
      highOrCritical: "高影响或重大影响",
      criticalOnly: "仅重大影响",
      includeControversy: "包括争议事件",
      controversyHelp: "包括已报道的纠纷、指控和声誉事件。",
      saving: "正在保存规则…",
    },
  },
} satisfies Record<AppLocale, IntelligenceInboxCopy>;
