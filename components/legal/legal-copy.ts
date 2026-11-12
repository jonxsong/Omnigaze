import type { AppLocale } from "@/lib/app-locale";
import { DATA_DELETION_CONFIRMATION } from "@/lib/account-data-constants";

export type LegalPageKind = "privacy" | "terms" | "data";

type LegalSection = {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

type LegalDocument = {
  eyebrow: string;
  title: string;
  summary: string;
  status: string;
  sections: LegalSection[];
};

type LegalCopy = {
  locale: {
    group: string;
    english: string;
    chinese: string;
  };
  navigation: {
    home: string;
    dashboard: string;
    privacy: string;
    terms: string;
    data: string;
    legal: string;
    headerLegal: string;
    footerLegal: string;
  };
  effective: string;
  updated: string;
  researchBoundary: string;
  documents: Record<LegalPageKind, LegalDocument>;
  snapshot: {
    title: string;
    body: string;
    anonymousBody: string;
    signIn: string;
    action: string;
    working: string;
    successTitle: string;
    successBody: string;
    failure: string;
  };
  deletion: {
    title: string;
    body: string;
    anonymousBody: string;
    signIn: string;
    confirmationLabel: string;
    confirmationHint: string;
    confirmationPlaceholder: string;
    action: string;
    working: string;
    successTitle: string;
    successBody: string;
    failure: string;
    dashboard: string;
  };
};

const effectiveDate = "November 12, 2026";

const en: LegalCopy = {
  locale: {
    group: "Policy page language",
    english: "English",
    chinese: "中文",
  },
  navigation: {
    home: "Home",
    dashboard: "Dashboard",
    privacy: "Privacy",
    terms: "Terms",
    data: "Data & deletion",
    legal: "Policy navigation",
    headerLegal: "Primary policy navigation",
    footerLegal: "Footer policy navigation",
  },
  effective: `Effective ${effectiveDate}`,
  updated: `Last updated ${effectiveDate}`,
  researchBoundary:
    "Omnigaze provides research support. It does not provide personalized investment advice, execute trades, or guarantee outcomes.",
  documents: {
    privacy: {
      eyebrow: "PRIVACY AT THE ALPHA",
      title: "Privacy, explained plainly.",
      summary:
        "This notice describes the data the current Omnigaze public alpha receives, where it is kept, and the choices available to you.",
      status:
        "Omnigaze is an early-stage product. This notice is scoped to the features currently shipped and will be revised before materially different data use begins.",
      sections: [
        {
          id: "data-we-receive",
          title: "Data we receive",
          paragraphs: [
            "When you sign in through ChatGPT Sites, the hosting platform supplies a site-specific user identifier and may supply your email address and display name. Omnigaze uses the identifier to separate your records. The application reads email or display name for the signed-in interface but does not copy either value into its application-owned D1 tables.",
          ],
          bullets: [
            "Watchlists, user-entered share quantities and average cost, portfolio preferences, inbox state, and in-app alert rules that you choose to save.",
            "A device-local onboarding draft, dashboard preferences, and language choice stored in your browser.",
            "AI request bookkeeping, short-lived validated results, and evidence fingerprints used for rate limits, cache safety, and reliable retries.",
            "Privacy-bounded request timing, outcome, and incident metadata in the hosting platform's operational logs. Omnigaze does not add an application telemetry database.",
          ],
        },
        {
          id: "how-we-use-data",
          title: "How the alpha uses data",
          paragraphs: [
            "Omnigaze uses saved data to render your dashboard, calculate deterministic portfolio context, synchronize your research state, enforce model-use limits, recover safely from conflicts, and diagnose failures. It is not used to place orders or make autonomous trading decisions.",
            "The current alpha has no advertising system and does not sell personal data.",
          ],
        },
        {
          id: "providers-and-ai",
          title: "Providers and AI",
          paragraphs: [
            "Market data and licensed news may come from Alpaca. Configured filing data may come from SEC EDGAR. Hosting, identity, Worker execution, and D1 storage are provided through OpenAI Sites and its Cloudflare-based runtime. Source links can take you to third-party sites with their own policies.",
            "When you explicitly request an Omnigaze View or Daily Brief, the server can send a bounded evidence package and the requested locale to the configured OpenAI model. The model is constrained to supplied evidence identifiers. Raw model prompts, API keys, request headers, and raw provider payloads are not stored in the AI cache.",
          ],
        },
        {
          id: "retention",
          title: "Retention and separation",
          paragraphs: [
            "Device-local data remains until you clear it. Owner-scoped records remain until you remove them or use the authenticated account-data deletion control. A single-stock AI cache normally expires within five minutes; a personalized Daily Brief cache normally expires within six hours. Model-budget and operational records can remain longer for abuse prevention and reliability.",
            "Normalized market, news, and filing evidence is owner-agnostic. Deleting your personal records does not delete public-source evidence used across the product. Hosting logs follow the platform's retention controls rather than an Omnigaze application table.",
          ],
        },
        {
          id: "security-and-choices",
          title: "Security and your choices",
          paragraphs: [
            "Provider and model credentials stay on the server. Personal API responses are no-store and owner identity is derived from trusted hosting headers rather than caller input. No internet service can promise absolute security.",
            "You can use the alpha without signing in for device-local exploration, remove individual holdings and watchlist entries in the dashboard, clear device data, or delete the owner-scoped records associated with the current signed-in Omnigaze identity from the Data & deletion page.",
          ],
        },
        {
          id: "contact",
          title: "Questions",
          paragraphs: [
            "A dedicated privacy mailbox is not yet published. The authenticated deletion control is the supported personal-data deletion path during the alpha. For non-sensitive product questions, use the public project repository and never post holdings, identity data, credentials, or deletion details in a public issue.",
          ],
        },
      ],
    },
    terms: {
      eyebrow: "ALPHA USE TERMS",
      title: "Use Omnigaze as research—not a promise.",
      summary:
        "These terms set the boundary for the current public alpha and the market information it presents.",
      status:
        "By using the alpha, you agree to use it lawfully and to make your own investment decisions. If you do not accept these terms, do not use the service.",
      sections: [
        {
          id: "research-only",
          title: "Research support only",
          paragraphs: [
            "Omnigaze organizes market data, public developments, licensed news, deterministic calculations, and evidence-grounded AI interpretation. It does not provide personalized investment advice, a fiduciary service, brokerage, tax or legal advice, or trade execution.",
            "Review zones, hypothetical share scenarios, evidence scores, and model confidence describe research inputs and assumptions. They are not price targets, return probabilities, or instructions to buy, sell, or hold a security.",
          ],
        },
        {
          id: "market-risk",
          title: "Market and data risk",
          paragraphs: [
            "Markets are volatile and losses are possible. Quotes, bars, news, filings, classifications, and AI output can be delayed, incomplete, corrected, unavailable, or wrong. ETF proxies do not isolate why an individual stock moved, and temporal proximity is not proof of causation.",
            "You are responsible for checking primary sources, considering your circumstances, and using a qualified professional where appropriate before acting.",
          ],
        },
        {
          id: "alpha-availability",
          title: "Alpha availability",
          paragraphs: [
            "The service is provided on an experimental, as-available basis. Features, providers, limits, and stored formats may change; a capability can fail closed when credentials, freshness, coverage, or infrastructure are unavailable. Omnigaze does not promise uninterrupted access, complete market coverage, or preservation of every alpha record.",
          ],
        },
        {
          id: "acceptable-use",
          title: "Acceptable use",
          paragraphs: [
            "Do not attempt to bypass authentication, owner boundaries, model budgets, provider limits, or security controls; probe other users' data; upload malicious content; misrepresent Omnigaze output as professional advice; or use the service in violation of law or third-party data terms.",
          ],
        },
        {
          id: "third-parties",
          title: "Third-party services",
          paragraphs: [
            "Provider data, source links, sign-in, hosting, and AI processing depend on third parties. Their terms and availability can apply independently. Omnigaze does not control the content or continued availability of linked sources.",
          ],
        },
        {
          id: "responsibility",
          title: "Responsibility and changes",
          paragraphs: [
            "To the extent permitted by applicable law, you use the alpha and rely on its output at your own risk. Omnigaze is not responsible for trading losses or decisions made from incomplete, delayed, or inferred information.",
            "Material changes to these terms will be reflected by a new effective date on this page. Continued use after a change means you accept the revised alpha terms.",
          ],
        },
      ],
    },
    data: {
      eyebrow: "YOUR DATA CONTROLS",
      title: "Know what is stored. Remove what is yours.",
      summary:
        "Omnigaze separates browser-only setup, signed-in personal records, shared market evidence, and operational logs so deletion claims stay precise.",
      status:
        "Account-data deletion is immediate when the authenticated request succeeds. It removes Omnigaze personal records, not your ChatGPT account, public market evidence, or hosting-platform logs.",
      sections: [
        {
          id: "device-data",
          title: "Data on this device",
          paragraphs: [
            "The onboarding draft, anonymous watchlist and positions, dashboard preferences, and language choice can be stored in this browser. Use your browser's site-data controls to remove them. A successful account-data deletion also clears the known Omnigaze browser keys on the device used for the request.",
          ],
        },
        {
          id: "account-data",
          title: "Signed-in Omnigaze records",
          paragraphs: [
            "Saved watchlists, holdings, portfolio profile, inbox state, in-app alert rules and deliveries, owner projection state, personalized Daily Brief cache entries, and model-budget rows are keyed to the current site-specific user identifier.",
            "You can remove individual stocks, holdings, and rules from their dashboard controls. The authenticated deletion control below removes the full owner-scoped set in one D1 batch. Visiting the dashboard again can create a new empty default watchlist.",
          ],
        },
        {
          id: "not-deleted",
          title: "What account deletion does not remove",
          paragraphs: [
            "Global market, news, and filing evidence is not tied to one owner and remains available to other users. Short-lived single-symbol AI cache entries are evidence-keyed rather than owner-keyed. Operational logs remain subject to the hosting platform's retention. Your ChatGPT identity and account are controlled by the platform, not this Omnigaze control.",
          ],
        },
        {
          id: "before-deleting",
          title: "Before you delete",
          paragraphs: [
            "Deletion cannot be undone from Omnigaze. Before continuing, you can download the bounded saved-data snapshot below. It reports total, exported, and truncated counts for growing sections, but it is not a complete platform or account archive and excludes shared market evidence, platform logs, credentials, and internal safety records. The deletion request is intentionally sign-in gated and requires an exact confirmation phrase.",
          ],
        },
        {
          id: "contact",
          title: "Contact boundary",
          paragraphs: [
            "The authenticated control below is the supported deletion path. A dedicated private support mailbox is not yet published. For non-sensitive product questions, use the public repository; never post holdings, identity data, credentials, or deletion details publicly.",
          ],
        },
      ],
    },
  },
  snapshot: {
    title: "Download a saved-data snapshot",
    body:
      "Download a JSON copy of the owner-scoped Omnigaze records currently available for export. The file includes section-level truncation metadata and excludes shared evidence, platform logs, credentials, prompts, leases, hashes, and other internal safety data. Downloading does not change or delete anything.",
    anonymousBody:
      "Sign in with the identity whose saved Omnigaze records you want to download. Authentication is required before a snapshot is created.",
    signIn: "Sign in to download data",
    action: "Download JSON snapshot",
    working: "Preparing snapshot…",
    successTitle: "Download started",
    successBody:
      "Your bounded JSON snapshot was prepared without changing your saved Omnigaze data.",
    failure:
      "The snapshot could not be prepared. No download is being claimed; try again.",
  },
  deletion: {
    title: "Delete saved account data",
    body:
      "This erases the owner-scoped Omnigaze records listed above now. It is not permanent account closure: signing in or using a connected client again can create a new empty workspace. It does not close your ChatGPT account or place, cancel, or change any trade.",
    anonymousBody:
      "Sign in with the identity whose Omnigaze records you want to delete. Authentication is required before the destructive request is accepted.",
    signIn: "Sign in to manage data",
    confirmationLabel: `Type ${DATA_DELETION_CONFIRMATION} to confirm`,
    confirmationHint: "The confirmation must match exactly.",
    confirmationPlaceholder: DATA_DELETION_CONFIRMATION,
    action: "Delete my saved Omnigaze data",
    working: "Deleting saved data…",
    successTitle: "Your saved Omnigaze data was deleted",
    successBody:
      "Owner-scoped records and known browser keys on this device have been removed. Shared market evidence and platform-managed logs are outside this deletion scope.",
    failure: "Deletion could not be completed. No successful deletion is being claimed; try again.",
    dashboard: "Sign out and return home",
  },
};

const zhCN: LegalCopy = {
  locale: {
    group: "政策页面语言",
    english: "English",
    chinese: "中文",
  },
  navigation: {
    home: "首页",
    dashboard: "仪表盘",
    privacy: "隐私说明",
    terms: "使用条款",
    data: "数据与删除",
    legal: "政策导航",
    headerLegal: "主要政策导航",
    footerLegal: "页脚政策导航",
  },
  effective: "生效日期：2026年11月12日",
  updated: "最后更新：2026年11月12日",
  researchBoundary:
    "Omnigaze 仅提供研究支持，不提供个性化投资建议、不执行交易，也不保证任何结果。",
  documents: {
    privacy: {
      eyebrow: "ALPHA 版隐私说明",
      title: "用清晰的语言说明隐私。",
      summary:
        "本说明介绍当前 Omnigaze 公共 Alpha 版会接收哪些数据、数据存放在哪里，以及你可以进行哪些控制。",
      status:
        "Omnigaze 仍处于早期阶段。本说明只覆盖目前已经上线的功能；在开始任何实质不同的数据用途前，我们会更新本说明。",
      sections: [
        {
          id: "data-we-receive",
          title: "我们接收的数据",
          paragraphs: [
            "当你通过 ChatGPT Sites 登录时，托管平台会提供该站点专用的用户标识符，并可能提供你的电子邮箱和显示名称。Omnigaze 使用该标识符隔离不同用户的记录。应用会读取邮箱或显示名称用于登录界面，但不会把它们复制到 Omnigaze 自有的 D1 数据表中。",
          ],
          bullets: [
            "你主动保存的自选股、持股数量、平均成本、投资组合偏好、收件箱状态和站内提醒规则。",
            "保存在浏览器中的设备本地引导草稿、仪表盘偏好和语言选择。",
            "用于限流、缓存安全和可靠重试的 AI 请求记录、短期有效结果与证据指纹。",
            "托管平台运行日志中的有限请求耗时、结果和事故元数据。Omnigaze 不另建应用遥测数据库。",
          ],
        },
        {
          id: "how-we-use-data",
          title: "Alpha 版如何使用数据",
          paragraphs: [
            "Omnigaze 使用已保存的数据来生成你的仪表盘、计算确定性的投资组合背景、同步研究状态、执行模型使用限额、安全处理冲突并诊断故障。它不会用这些数据下单或自动做出交易决策。",
            "当前 Alpha 版没有广告系统，也不出售个人数据。",
          ],
        },
        {
          id: "providers-and-ai",
          title: "数据供应商与 AI",
          paragraphs: [
            "市场数据和授权新闻可能来自 Alpaca；配置后的申报数据可能来自 SEC EDGAR；OpenAI Sites 及其基于 Cloudflare 的运行环境提供托管、身份、Worker 执行和 D1 存储。来源链接会跳转到拥有独立政策的第三方网站。",
            "只有在你明确请求 Omnigaze 观点或每日简报时，服务器才会把有限的证据包和所选语言发送给已配置的 OpenAI 模型。模型只能引用服务器提供的证据标识符。原始模型提示词、API 密钥、请求头和供应商原始载荷不会写入 AI 缓存。",
          ],
        },
        {
          id: "retention",
          title: "保留与隔离",
          paragraphs: [
            "设备本地数据会保留到你主动清除为止。个人记录会保留到你删除单项数据或使用已登录的账户数据删除控件。单只股票的 AI 缓存通常最多保留五分钟；个性化每日简报缓存通常最多保留六小时。用于防滥用和可靠性的模型额度与运行记录可能保留更久。",
            "标准化市场、新闻和申报证据不属于某一个用户。删除个人记录不会删除供整个产品使用的公开来源证据。托管日志遵循平台的保留规则，而不是 Omnigaze 应用数据表。",
          ],
        },
        {
          id: "security-and-choices",
          title: "安全与选择",
          paragraphs: [
            "供应商和模型密钥只保留在服务器端。个人 API 响应禁止缓存，用户身份来自受信任的托管请求头，而不是调用者输入。任何互联网服务都无法承诺绝对安全。",
            "你可以不登录并仅在本设备体验 Alpha 版；也可以在仪表盘删除单项持仓和自选股、清除设备数据，或在“数据与删除”页面删除当前 Omnigaze 登录身份对应的个人记录。",
          ],
        },
        {
          id: "contact",
          title: "问题与联系",
          paragraphs: [
            "Alpha 版尚未公布专用隐私邮箱。已登录的删除控件是目前支持的个人数据删除路径。非敏感产品问题可以通过公开项目仓库反馈，但请勿在公开 Issue 中发布持仓、身份信息、密钥或删除详情。",
          ],
        },
      ],
    },
    terms: {
      eyebrow: "ALPHA 版使用条款",
      title: "把 Omnigaze 当作研究工具，而不是承诺。",
      summary:
        "本条款说明当前公共 Alpha 版以及其中市场信息的使用边界。",
      status:
        "使用 Alpha 版即表示你同意合法使用，并独立作出投资决策。如果你不接受本条款，请勿使用本服务。",
      sections: [
        {
          id: "research-only",
          title: "仅供研究支持",
          paragraphs: [
            "Omnigaze 整理市场数据、公开事件、授权新闻、确定性计算以及有证据支撑的 AI 解读。它不提供个性化投资建议、受托服务、经纪服务、税务或法律建议，也不执行交易。",
            "审查区间、假设性股数情景、证据评分和模型置信度只用于描述研究输入与假设，不是目标价、回报概率或买入、卖出、持有指令。",
          ],
        },
        {
          id: "market-risk",
          title: "市场与数据风险",
          paragraphs: [
            "市场存在波动，投资可能亏损。报价、K 线、新闻、申报、分类和 AI 输出可能延迟、不完整、被更正、不可用或错误。ETF 代理无法单独解释某只股票为何波动，时间接近也不等于因果关系。",
            "在采取行动前，你有责任核对原始来源、结合自身情况，并在需要时咨询合格专业人士。",
          ],
        },
        {
          id: "alpha-availability",
          title: "Alpha 版可用性",
          paragraphs: [
            "本服务以实验性、按现状可用的方式提供。功能、供应商、限额和存储格式可能变化；当密钥、时效性、覆盖范围或基础设施不可用时，相关能力可能按安全原则关闭。Omnigaze 不承诺持续可用、完整市场覆盖或永久保存每一条 Alpha 记录。",
          ],
        },
        {
          id: "acceptable-use",
          title: "可接受的使用方式",
          paragraphs: [
            "不得尝试绕过身份验证、用户隔离、模型额度、供应商限制或安全控制；不得探测其他用户数据、上传恶意内容、把 Omnigaze 输出冒充专业建议，或违反法律及第三方数据条款。",
          ],
        },
        {
          id: "third-parties",
          title: "第三方服务",
          paragraphs: [
            "供应商数据、来源链接、登录、托管和 AI 处理依赖第三方，其条款和可用性可能独立适用。Omnigaze 无法控制外部来源的内容或持续可用性。",
          ],
        },
        {
          id: "responsibility",
          title: "责任与变更",
          paragraphs: [
            "在适用法律允许的范围内，你自行承担使用 Alpha 版及依赖其输出的风险。Omnigaze 不对基于不完整、延迟或推断信息作出的交易决定或损失负责。",
            "如本条款发生实质变更，本页面会更新生效日期。变更后继续使用即表示你接受修订后的 Alpha 条款。",
          ],
        },
      ],
    },
    data: {
      eyebrow: "你的数据控制",
      title: "知道存了什么，也能删除属于你的数据。",
      summary:
        "Omnigaze 区分浏览器本地设置、已登录个人记录、共享市场证据和运行日志，从而准确说明删除范围。",
      status:
        "已登录的删除请求成功后，账户数据会立即删除。它会删除 Omnigaze 个人记录，但不会删除你的 ChatGPT 账户、公共市场证据或托管平台日志。",
      sections: [
        {
          id: "device-data",
          title: "本设备上的数据",
          paragraphs: [
            "引导草稿、匿名自选股与持仓、仪表盘偏好和语言选择可能保存在本浏览器中。你可以使用浏览器的站点数据设置清除它们。账户数据删除成功后，也会清除发起请求设备上的已知 Omnigaze 浏览器键。",
          ],
        },
        {
          id: "account-data",
          title: "已登录的 Omnigaze 记录",
          paragraphs: [
            "已保存的自选股、持仓、投资组合资料、收件箱状态、站内提醒规则及投递记录、个人投影状态、个性化每日简报缓存和模型额度记录，都与当前站点专用用户标识符关联。",
            "你可以通过仪表盘控件删除单只股票、持仓和提醒规则。下面的已登录删除控件会在一个 D1 批处理中删除全部个人记录。之后再次访问仪表盘，可能会创建一个新的空白默认自选股。",
          ],
        },
        {
          id: "not-deleted",
          title: "账户删除不会移除的内容",
          paragraphs: [
            "全局市场、新闻和申报证据不属于某一个用户，因此会继续供其他用户使用。短期单股票 AI 缓存按证据而不是按用户建立。运行日志继续遵循托管平台的保留规则。你的 ChatGPT 身份和账户由平台管理，不属于本 Omnigaze 删除控件的范围。",
          ],
        },
        {
          id: "before-deleting",
          title: "删除之前",
          paragraphs: [
            "Omnigaze 无法撤销删除。继续之前，你可以下载下方有范围限制的已保存数据快照。对于会增长的分区，快照会列出总数、已导出数量和是否截断；但它不是完整的平台或账户归档，也不包含共享市场证据、平台日志、密钥或内部安全记录。删除请求必须先登录，并输入完全一致的确认短语。",
          ],
        },
        {
          id: "contact",
          title: "联系边界",
          paragraphs: [
            "下方已登录控件是目前支持的删除路径。Alpha 版尚未公布专用私密支持邮箱。非敏感产品问题可以通过公开仓库反馈；请勿公开发布持仓、身份信息、密钥或删除详情。",
          ],
        },
      ],
    },
  },
  snapshot: {
    title: "下载已保存数据快照",
    body:
      "下载当前可导出的个人 Omnigaze 记录 JSON 副本。文件包含分区级截断信息，但不包含共享证据、平台日志、密钥、提示词、租约、哈希或其他内部安全数据。下载不会更改或删除任何内容。",
    anonymousBody:
      "请使用需要下载 Omnigaze 记录的身份登录。系统仅会在完成身份验证后创建快照。",
    signIn: "登录并下载数据",
    action: "下载 JSON 快照",
    working: "正在准备快照…",
    successTitle: "下载已开始",
    successBody:
      "有范围限制的 JSON 快照已准备完成，不会更改你保存的 Omnigaze 数据。",
    failure: "快照准备失败。系统不会把失败请求描述为已下载；请重试。",
  },
  deletion: {
    title: "删除已保存的账户数据",
    body:
      "这会立即清除上文列出的个人 Omnigaze 记录，但不代表永久关闭账户：再次登录或使用已连接的客户端，可能会创建新的空白工作区。它不会关闭你的 ChatGPT 账户，也不会提交、取消或修改任何交易。",
    anonymousBody:
      "请使用需要删除 Omnigaze 记录的身份登录。只有完成身份验证后，系统才会接受此破坏性请求。",
    signIn: "登录并管理数据",
    confirmationLabel: `输入 ${DATA_DELETION_CONFIRMATION} 以确认`,
    confirmationHint: "确认内容必须完全一致。",
    confirmationPlaceholder: DATA_DELETION_CONFIRMATION,
    action: "删除我保存的 Omnigaze 数据",
    working: "正在删除已保存的数据…",
    successTitle: "你保存的 Omnigaze 数据已删除",
    successBody:
      "个人记录以及本设备上的已知浏览器键已被删除。共享市场证据和平台管理的日志不属于本次删除范围。",
    failure: "删除未能完成。系统不会把失败请求描述为已删除；请重试。",
    dashboard: "退出登录并返回首页",
  },
};

export const legalPageCopy = {
  en,
  "zh-CN": zhCN,
} satisfies Record<AppLocale, LegalCopy>;

