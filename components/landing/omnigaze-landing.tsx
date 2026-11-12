"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { MotionConfig, motion } from "framer-motion";
import {
  ArrowRight,
  Bell,
  Bot,
  Braces,
  Check,
  Database,
  Eye,
  FileSearch,
  Gauge,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import {
  LandingLocaleProvider,
  type LandingLocale,
  useLandingLocale,
} from "./landing-locale";
import styles from "./omnigaze-landing.module.css";

export interface OmnigazeLandingProps {
  howItWorks?: ReactNode;
}

const watchlist = [
  { ticker: "NVDA", price: "$188.42", change: "+3.12%", positive: true },
  { ticker: "MSFT", price: "$519.64", change: "−0.41%", positive: false },
  { ticker: "AMD", price: "$241.16", change: "+1.73%", positive: true },
  { ticker: "AAPL", price: "$276.24", change: "+0.20%", positive: true },
];

const trustIcons = [FileSearch, ShieldCheck, Zap, Network];
const featureMeta = [
  { icon: Eye, accent: "cyan" },
  { icon: FileSearch, accent: "mint" },
  { icon: Bell, accent: "amber" },
  { icon: Gauge, accent: "violet" },
] as const;

const landingCopy = {
  en: {
    locale: { group: "Landing page language", english: "English", chinese: "中文" },
    header: {
      home: "Omnigaze home",
      earlyAccess: "EARLY ACCESS",
      navigation: "Primary navigation",
      product: "Product",
      how: "How it works",
      intelligence: "Intelligence",
      trust: "Trust",
      openAlpha: "Open alpha",
    },
    hero: {
      eyebrow: "AI-native market intelligence",
      title: "See what moves your stocks.",
      titleAccent: "Know why it matters.",
      body: "Omnigaze turns price action, filings, and market news into one personalized, evidence-backed view of the companies you track.",
      primary: "Explore the alpha",
      secondary: "See how it works",
      principles: "Product principles",
      proof: ["Source-linked insights", "Explicit confidence", "No auto-trading"],
      detected: "EVENT DETECTED",
      evidence: "Evidence",
    },
    product: {
      eyebrow: "THE MARKET WORKSPACE, REIMAGINED",
      title: "Everything you track.",
      titleAccent: "One intelligent view.",
      body: "Charts tell you what happened. Omnigaze connects the event, the evidence, and its potential impact.",
    },
    preview: {
      workspaceAria: "Illustrative Omnigaze market workspace; scroll horizontally on smaller screens",
      search: "Search stocks, filings, or events",
      marketOpen: "Market open",
      watchlistAria: "Preview watchlist",
      myWatchlist: "MY WATCHLIST",
      coreHoldings: "Core holdings",
      columns: ["Symbol", "Last", "Change"],
      eventsToday: "material events today",
      movementAria: "NVDA market movement preview",
      previousClose: "Previous close",
      volume: "Volume",
      coverage: "Coverage",
      providerFeed: "Provider feed",
      price: "PRICE",
      marketMovement: "Market movement",
      ranges: ["1D", "1W", "1M", "1Y"],
      chartAria: "Illustrative rising NVDA price chart",
      analyzed: "10-Q analyzed",
      impact: "HIGH IMPACT · 6 MIN AGO",
      event: "Datacenter outlook strengthened in new disclosure",
      viewAria: "Omnigaze View preview",
      synthesis: "Evidence-backed synthesis",
      stance: "Near-term stance",
      constructive: "Constructive",
      confidence: "confidence",
      viewTitle: "Demand evidence is strengthening.",
      viewBody: "Recent disclosures reinforce accelerator demand while export restrictions remain the clearest counterweight.",
      whyNow: "WHY NOW",
      whyBody: "New capacity commentary aligns with positive supplier read-throughs.",
      keyDrivers: "KEY DRIVERS",
      datacenter: "Datacenter demand",
      positive: "Positive",
      export: "Export exposure",
      mixed: "Mixed",
      ask: "Ask Omnigaze",
      productPreview: "Product preview",
      disclaimer: "Illustrative market data · not a live quote",
      swipe: "Swipe horizontally to explore the workspace",
    },
    trustAria: "Omnigaze trust principles",
    trust: [
      { label: "Primary-source evidence", detail: "Every view traces back to its source." },
      { label: "Confidence, not certainty", detail: "Unknowns and conflicting signals stay visible." },
      { label: "Event-driven by design", detail: "Material changes surface as they happen." },
      { label: "MCP-native intelligence", detail: "One secure tool layer for agents and apps." },
    ],
    featuresIntro: {
      eyebrow: "BUILT AROUND YOUR ATTENTION",
      title: "A research system that",
      titleAccent: "thinks in context.",
    },
    features: [
      {
        label: "Personal command center",
        title: "Your market, not the whole market.",
        body: "Build watchlists around the companies you care about. Omnigaze ranks every event by its relevance to you.",
      },
      {
        label: "Evidence graph",
        title: "See the source behind the story.",
        body: "Filings, market data, and licensed news stay connected to every Omnigaze interpretation.",
      },
      {
        label: "Roadmap · semantic alerts",
        title: "Know when the thesis changes.",
        body: "Planned alerts will move beyond price thresholds to guidance changes, new risks, and contradictory evidence.",
      },
      {
        label: "Signal calibration",
        title: "Less noise. More materiality.",
        body: "Omnigaze separates facts, derived observations, and inference—then shows confidence and what remains unknown.",
      },
    ],
    intelligence: {
      eyebrow: "INTELLIGENCE INFRASTRUCTURE",
      title: "Evidence in.",
      titleAccent: "Explainable intelligence out.",
      body: "Omnigaze keeps collection, interpretation, and action boundaries distinct—so every insight remains inspectable, permissioned, and useful beyond a single screen.",
      bullets: [
        "Facts, derived signals, and AI inference stay visibly separate.",
        "Point-in-time context prevents future evidence from leaking backward.",
        "MCP tools make the same intelligence available to trusted agents.",
      ],
      inspect: "Inspect the product",
      pipelineAria: "Omnigaze intelligence pipeline",
      pipeline: "OMNIGAZE PIPELINE",
      traceable: "Traceable by design",
      sources: "01 · SOURCES",
      sourceList: "Filings · Market data · Licensed news",
      ingest: "INGEST",
      normalized: "normalized + timestamped",
      engine: "02 · EVIDENCE ENGINE",
      engineList: "Materiality · Provenance · Contradictions",
      reason: "REASON",
      confidence: "confidence + unknowns",
      view: "03 · OMNIGAZE VIEW",
      viewDetail: "Evidence-backed market interpretation",
      explain: "EXPLAIN",
    },
    finalCta: {
      eyebrow: "YOUR MARKET IS ALREADY MOVING",
      title: "Watch less.",
      titleAccent: "Understand more.",
      body: "Build your watchlist and let Omnigaze connect the signals that matter.",
      action: "Enter the alpha",
    },
    footer: {
      tagline: "Your market. One intelligent view.",
      product: "Product",
      intelligence: "Intelligence",
      trust: "Trust",
      dashboard: "Dashboard",
      disclaimer: "Research support only. Not investment advice.",
    },
  },
  "zh-CN": {
    locale: { group: "落地页语言", english: "English", chinese: "中文" },
    header: {
      home: "Omnigaze 首页",
      earlyAccess: "抢先体验",
      navigation: "主导航",
      product: "产品",
      how: "工作原理",
      intelligence: "智能引擎",
      trust: "可信设计",
      openAlpha: "打开 Alpha 版",
    },
    hero: {
      eyebrow: "AI 原生市场情报",
      title: "洞察股票为何波动。",
      titleAccent: "理解它为何重要。",
      body: "Omnigaze 将价格走势、监管文件与市场新闻整合为一个个性化、有证据支撑的关注公司视图。",
      primary: "体验 Alpha 版",
      secondary: "了解工作原理",
      principles: "产品原则",
      proof: ["洞察可追溯至来源", "明确展示置信度", "不提供自动交易"],
      detected: "检测到事件",
      evidence: "证据",
    },
    product: {
      eyebrow: "重构市场工作台",
      title: "你关注的一切。",
      titleAccent: "汇成一个智能视图。",
      body: "图表告诉你发生了什么。Omnigaze 将事件、证据及其潜在影响连接起来。",
    },
    preview: {
      workspaceAria: "Omnigaze 市场工作台示意图；在较小屏幕上可横向滚动",
      search: "搜索股票、监管文件或事件",
      marketOpen: "市场交易中",
      watchlistAria: "关注列表预览",
      myWatchlist: "我的关注列表",
      coreHoldings: "核心持仓",
      columns: ["代码", "最新价", "涨跌幅"],
      eventsToday: "个重大事件（今日）",
      movementAria: "NVDA 市场走势预览",
      previousClose: "前收盘价",
      volume: "成交量",
      coverage: "覆盖范围",
      providerFeed: "数据提供方",
      price: "价格",
      marketMovement: "市场走势",
      ranges: ["1日", "1周", "1月", "1年"],
      chartAria: "NVDA 上涨价格图表示意",
      analyzed: "已分析 10-Q",
      impact: "高影响 · 6 分钟前",
      event: "新披露显示数据中心前景增强",
      viewAria: "Omnigaze View 预览",
      synthesis: "有证据支撑的综合研判",
      stance: "短期观点",
      constructive: "偏积极",
      confidence: "置信度",
      viewTitle: "需求证据正在增强。",
      viewBody: "近期披露进一步印证加速器需求，而出口限制仍是最明确的制衡因素。",
      whyNow: "为何是现在",
      whyBody: "新的产能评论与供应商释放的积极信号相互印证。",
      keyDrivers: "关键驱动因素",
      datacenter: "数据中心需求",
      positive: "积极",
      export: "出口敞口",
      mixed: "多空交织",
      ask: "询问 Omnigaze",
      productPreview: "产品预览",
      disclaimer: "示例市场数据 · 非实时行情",
      swipe: "左右滑动以浏览工作台",
    },
    trustAria: "Omnigaze 可信设计原则",
    trust: [
      { label: "原始来源证据", detail: "每个观点都可追溯至其来源。" },
      { label: "置信度，而非确定性", detail: "未知项和冲突信号始终可见。" },
      { label: "事件驱动设计", detail: "重大变化发生时及时浮现。" },
      { label: "MCP 原生智能", detail: "为智能体和应用提供统一、安全的工具层。" },
    ],
    featuresIntro: {
      eyebrow: "围绕你的注意力构建",
      title: "一套能够",
      titleAccent: "结合上下文思考的研究系统。",
    },
    features: [
      {
        label: "个人指挥中心",
        title: "只看你的市场，而非整个市场。",
        body: "围绕你关心的公司创建关注列表。Omnigaze 会按与你的相关程度对每个事件排序。",
      },
      {
        label: "证据图谱",
        title: "看见叙事背后的来源。",
        body: "监管文件、市场数据与授权新闻始终与每项 Omnigaze 解读相连。",
      },
      {
        label: "路线图 · 语义提醒",
        title: "及时发现投资逻辑的变化。",
        body: "计划中的提醒将超越价格阈值，覆盖指引变化、新风险与相互矛盾的证据。",
      },
      {
        label: "信号校准",
        title: "更少噪声，更高重要性。",
        body: "Omnigaze 将事实、衍生观察与推断分开，并展示置信度及仍然未知的部分。",
      },
    ],
    intelligence: {
      eyebrow: "智能基础设施",
      title: "证据输入。",
      titleAccent: "可解释的智能输出。",
      body: "Omnigaze 将采集、解读与行动边界清晰分开，让每项洞察都可检查、受权限控制，并能在单一界面之外继续发挥作用。",
      bullets: [
        "事实、衍生信号与 AI 推断始终清晰区分。",
        "时点上下文可防止未来证据倒灌到过去。",
        "MCP 工具让可信智能体也能使用同一套智能。",
      ],
      inspect: "查看产品",
      pipelineAria: "Omnigaze 智能处理流程",
      pipeline: "OMNIGAZE 处理流程",
      traceable: "设计即支持追溯",
      sources: "01 · 数据源",
      sourceList: "监管文件 · 市场数据 · 授权新闻",
      ingest: "采集",
      normalized: "标准化 + 时间戳",
      engine: "02 · 证据引擎",
      engineList: "重要性 · 来源脉络 · 矛盾证据",
      reason: "推理",
      confidence: "置信度 + 未知项",
      view: "03 · OMNIGAZE VIEW",
      viewDetail: "有证据支撑的市场解读",
      explain: "解释",
    },
    finalCta: {
      eyebrow: "你的市场已经在变化",
      title: "少看一些。",
      titleAccent: "多懂一些。",
      body: "创建你的关注列表，让 Omnigaze 连接真正重要的信号。",
      action: "进入 Alpha 版",
    },
    footer: {
      tagline: "你的市场，一个智能视图。",
      product: "产品",
      intelligence: "智能引擎",
      trust: "可信设计",
      dashboard: "仪表盘",
      disclaimer: "仅供研究参考，不构成投资建议。",
    },
  },
} satisfies Record<LandingLocale, object>;

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function ProductPreview() {
  const { locale } = useLandingLocale();
  const copy = landingCopy[locale].preview;

  return (
    <motion.div
      className={styles.previewWrap}
      initial={{ opacity: 0, y: 24, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.65, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className={styles.previewGlow} aria-hidden="true" />
      <article
        className={styles.productPreview}
        aria-label={copy.workspaceAria}
        aria-describedby="landing-preview-scroll-hint"
        tabIndex={0}
      >
        <div className={styles.previewTopbar}>
          <div className={styles.previewBrand}>
            <BrandMark />
            <strong>OMNIGAZE</strong>
          </div>
          <div className={styles.previewSearch}>
            <Search size={12} aria-hidden="true" />
            <span>{copy.search}</span>
            <kbd>⌘ K</kbd>
          </div>
          <span className={styles.marketOpen}><i /> {copy.marketOpen}</span>
        </div>

        <div className={styles.previewGrid}>
          <aside className={styles.watchlistPreview} aria-label={copy.watchlistAria}>
            <div className={styles.panelLabel}>
              <span>{copy.myWatchlist}</span>
              <b>+</b>
            </div>
            <strong className={styles.watchlistName}>{copy.coreHoldings}</strong>
            <div className={styles.watchlistHeader} aria-hidden="true">
              {copy.columns.map((column) => <span key={column}>{column}</span>)}
            </div>
            {watchlist.map((stock, index) => (
              <div
                className={[styles.watchlistRow, index === 0 ? styles.selectedRow : ""].join(" ")}
                key={stock.ticker}
              >
                <span className={styles.symbolCell}>
                  <i>{stock.ticker[0]}</i>
                  <strong>{stock.ticker}</strong>
                </span>
                <span>{stock.price}</span>
                <span className={stock.positive ? styles.positive : styles.negative}>{stock.change}</span>
              </div>
            ))}
            <div className={styles.watchlistPulse}>
              <Sparkles size={12} aria-hidden="true" />
              <span><strong>3</strong> {copy.eventsToday}</span>
            </div>
          </aside>

          <section className={styles.chartPreview} aria-label={copy.movementAria}>
            <div className={styles.symbolSummary}>
              <div>
                <span className={styles.symbolLogo}>N</span>
                <span><strong>NVDA</strong><small>NVIDIA Corporation</small></span>
              </div>
              <div><strong>$188.42</strong><span className={styles.positive}>+5.71 · 3.12%</span></div>
            </div>
            <div className={styles.metricRow}>
              <span><small>{copy.previousClose}</small><strong>$182.71</strong></span>
              <span><small>{copy.volume}</small><strong>38.4M</strong></span>
              <span><small>{copy.coverage}</small><strong>{copy.providerFeed}</strong></span>
            </div>
            <div className={styles.chartHeader}>
              <span><small>{copy.price}</small><strong>{copy.marketMovement}</strong></span>
              <span className={styles.timeRange}>
                {copy.ranges.map((range, index) => index === 0 ? <b key={range}>{range}</b> : <i key={range}>{range}</i>)}
              </span>
            </div>
            <div className={styles.chartGraphic}>
              <svg viewBox="0 0 620 235" role="img" aria-label={copy.chartAria}>
                <defs>
                  <linearGradient id="landing-chart-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#62d9ff" stopOpacity=".28" />
                    <stop offset="100%" stopColor="#62d9ff" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <g className={styles.gridLines}>
                  <path d="M0 38H620M0 93H620M0 148H620M0 203H620" />
                  <path d="M115 0V235M240 0V235M365 0V235M490 0V235" />
                </g>
                <path
                  className={styles.chartArea}
                  d="M0 205 C32 194 48 198 76 179 C103 161 126 174 151 151 C176 126 194 139 222 123 C251 107 274 120 299 95 C330 65 357 86 382 68 C408 48 429 60 452 41 C477 20 496 36 520 27 C550 15 571 23 620 5 L620 235 L0 235 Z"
                />
                <path
                  className={styles.chartLine}
                  d="M0 205 C32 194 48 198 76 179 C103 161 126 174 151 151 C176 126 194 139 222 123 C251 107 274 120 299 95 C330 65 357 86 382 68 C408 48 429 60 452 41 C477 20 496 36 520 27 C550 15 571 23 620 5"
                />
                <circle cx="452" cy="41" r="5" className={styles.eventPoint} />
                <circle cx="620" cy="5" r="5" className={styles.lastPoint} />
              </svg>
              <span className={styles.eventFlag}>{copy.analyzed}</span>
            </div>
            <div className={styles.previewEvent}>
              <span className={styles.eventIcon}><FileSearch size={14} /></span>
              <span><small>{copy.impact}</small><strong>{copy.event}</strong></span>
              <ArrowRight size={14} aria-hidden="true" />
            </div>
          </section>

          <aside className={styles.viewPreview} aria-label={copy.viewAria}>
            <div className={styles.viewTitle}>
              <span><Bot size={15} aria-hidden="true" /></span>
              <div><small>OMNIGAZE VIEW</small><strong>{copy.synthesis}</strong></div>
            </div>
            <div className={styles.stanceRow}>
              <span><small>{copy.stance}</small><strong>{copy.constructive}</strong></span>
              <span className={styles.confidence}><strong>84%</strong><small>{copy.confidence}</small></span>
            </div>
            <h3>{copy.viewTitle}</h3>
            <p>{copy.viewBody}</p>
            <div className={styles.whyNow}>
              <span><Zap size={12} /> {copy.whyNow}</span>
              <p>{copy.whyBody}</p>
            </div>
            <div className={styles.driverList}>
              <small>{copy.keyDrivers}</small>
              <span><i className={styles.driverPositive} /><b>{copy.datacenter}</b><em>{copy.positive}</em></span>
              <span><i className={styles.driverMixed} /><b>{copy.export}</b><em>{copy.mixed}</em></span>
            </div>
            <span className={styles.askPreview}><Sparkles size={13} /> {copy.ask}</span>
          </aside>
        </div>

        <div className={styles.previewCaption}>
          <span><i /> {copy.productPreview}</span>
          <span>{copy.disclaimer}</span>
        </div>
      </article>
      <p className={styles.mobilePreviewHint} id="landing-preview-scroll-hint">
        {copy.swipe} <ArrowRight size={12} aria-hidden="true" />
      </p>
    </motion.div>
  );
}

function LocaleToggle() {
  const { locale, setLocale } = useLandingLocale();
  const copy = landingCopy[locale].locale;

  return (
    <div className={styles.localeToggle} role="group" aria-label={copy.group}>
      <button
        type="button"
        lang="en"
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
      >
        {copy.english}
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        lang="zh-CN"
        aria-pressed={locale === "zh-CN"}
        onClick={() => setLocale("zh-CN")}
      >
        {copy.chinese}
      </button>
    </div>
  );
}

function OmnigazeLandingContent({ howItWorks }: OmnigazeLandingProps) {
  const { locale } = useLandingLocale();
  const copy = landingCopy[locale];
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <main
        ref={mainRef}
        className={styles.landing}
        lang={locale}
        data-locale={locale}
        data-hydrated="false"
      >
        <div className={styles.ambientOne} aria-hidden="true" />
        <div className={styles.ambientTwo} aria-hidden="true" />

        <header className={styles.header}>
          <a className={styles.brand} href="#top" aria-label={copy.header.home}>
            <BrandMark />
            <span>OMNIGAZE</span>
            <small>{copy.header.earlyAccess}</small>
          </a>
          <nav aria-label={copy.header.navigation}>
            <a href="#product">{copy.header.product}</a>
            <a href="#how-it-works">{copy.header.how}</a>
            <a href="#intelligence">{copy.header.intelligence}</a>
            <a href="#trust">{copy.header.trust}</a>
          </nav>
          <div className={styles.headerActions}>
            <LocaleToggle />
            <a className={styles.navCta} href="/onboarding">{copy.header.openAlpha} <ArrowRight size={14} /></a>
          </div>
        </header>

        <section className={styles.hero} id="top" aria-labelledby="hero-title">
          <motion.div
            className={styles.heroCopy}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.58, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className={styles.eyebrow}><Sparkles size={13} /> {copy.hero.eyebrow}</span>
            <h1 id="hero-title">{copy.hero.title}<br /><em>{copy.hero.titleAccent}</em></h1>
            <p>{copy.hero.body}</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryCta} href="/onboarding">{copy.hero.primary} <ArrowRight size={16} /></a>
              <a className={styles.secondaryCta} href="#how-it-works">{copy.hero.secondary}</a>
            </div>
            <div className={styles.heroProof} aria-label={copy.hero.principles}>
              {copy.hero.proof.map((item) => <span key={item}><Check size={13} /> {item}</span>)}
            </div>
          </motion.div>

          <div className={styles.heroSignal} aria-hidden="true">
            <span>{copy.hero.detected}</span>
            <i />
            <b>10-Q</b>
            <i />
            <b>{copy.hero.evidence}</b>
            <i />
            <b>Omnigaze View</b>
          </div>
        </section>

        <section className={styles.productSection} id="product" aria-labelledby="product-title">
          <div className={styles.sectionIntro}>
            <span className={styles.eyebrow}>{copy.product.eyebrow}</span>
            <h2 id="product-title">{copy.product.title}<br /><em>{copy.product.titleAccent}</em></h2>
            <p>{copy.product.body}</p>
          </div>
          <ProductPreview />
        </section>

        <section className={styles.trustStrip} id="trust" aria-label={copy.trustAria}>
          {copy.trust.map(({ label, detail }, index) => {
            const Icon = trustIcons[index] ?? ShieldCheck;
            return (
              <article key={label}>
                <span><Icon size={17} aria-hidden="true" /></span>
                <div><strong>{label}</strong><p>{detail}</p></div>
              </article>
            );
          })}
        </section>

        <section className={styles.featuresSection} aria-labelledby="features-title">
          <div className={styles.sectionIntro}>
            <span className={styles.eyebrow}>{copy.featuresIntro.eyebrow}</span>
            <h2 id="features-title">{copy.featuresIntro.title}<br /><em>{copy.featuresIntro.titleAccent}</em></h2>
          </div>
          <div className={styles.featureGrid}>
            {copy.features.map(({ label, title, body }, index) => {
              const meta = featureMeta[index] ?? featureMeta[0];
              const Icon = meta.icon;
              return (
                <article className={[styles.featureCard, styles[meta.accent]].join(" ")} key={label}>
                  <span className={styles.featureIcon}><Icon size={19} aria-hidden="true" /></span>
                  <small>{label}</small>
                  <h3>{title}</h3>
                  <p>{body}</p>
                  <span className={styles.cardLine} aria-hidden="true" />
                </article>
              );
            })}
          </div>
        </section>

        {howItWorks ? (
          <div className={styles.howItWorksSlot} id="how-it-works">
            {howItWorks}
          </div>
        ) : null}

        <section className={styles.intelligenceSection} id="intelligence" aria-labelledby="intelligence-title">
          <div className={styles.intelligenceCopy}>
            <span className={styles.eyebrow}><Braces size={13} /> {copy.intelligence.eyebrow}</span>
            <h2 id="intelligence-title">{copy.intelligence.title}<br /><em>{copy.intelligence.titleAccent}</em></h2>
            <p>{copy.intelligence.body}</p>
            <ul>
              {copy.intelligence.bullets.map((bullet) => <li key={bullet}><Check size={14} /> {bullet}</li>)}
            </ul>
            <a href="/dashboard">{copy.intelligence.inspect} <ArrowRight size={15} /></a>
          </div>

          <div className={styles.pipelineCard} aria-label={copy.intelligence.pipelineAria}>
            <div className={styles.pipelineHeader}>
              <span><i /> {copy.intelligence.pipeline}</span>
              <small>{copy.intelligence.traceable}</small>
            </div>
            <div className={styles.pipelineStep}>
              <span><Database size={17} /></span>
              <div><small>{copy.intelligence.sources}</small><strong>{copy.intelligence.sourceList}</strong></div>
              <em>{copy.intelligence.ingest}</em>
            </div>
            <div className={styles.pipelineConnector}><i /><span>{copy.intelligence.normalized}</span><i /></div>
            <div className={styles.pipelineStep}>
              <span><Workflow size={17} /></span>
              <div><small>{copy.intelligence.engine}</small><strong>{copy.intelligence.engineList}</strong></div>
              <em>{copy.intelligence.reason}</em>
            </div>
            <div className={styles.pipelineConnector}><i /><span>{copy.intelligence.confidence}</span><i /></div>
            <div className={[styles.pipelineStep, styles.pipelineHighlight].join(" ")}>
              <span><Bot size={17} /></span>
              <div><small>{copy.intelligence.view}</small><strong>{copy.intelligence.viewDetail}</strong></div>
              <em>{copy.intelligence.explain}</em>
            </div>
            <div className={styles.mcpConsole}>
              <div><span /><span /><span /><small>MCP · tools/list</small></div>
              <code><b>›</b> get_market_snapshot <i>NASDAQ:NVDA</i></code>
              <code><b>›</b> get_intelligence_feed <i>materiality: high</i></code>
              <code><b>›</b> get_omnigaze_view <i>horizon: near-term</i></code>
            </div>
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-cta-title">
          <div className={styles.ctaOrb} aria-hidden="true"><BrandMark /></div>
          <span className={styles.eyebrow}>{copy.finalCta.eyebrow}</span>
          <h2 id="final-cta-title">{copy.finalCta.title}<br /><em>{copy.finalCta.titleAccent}</em></h2>
          <p>{copy.finalCta.body}</p>
          <a className={styles.primaryCta} href="/onboarding">{copy.finalCta.action} <ArrowRight size={16} /></a>
        </section>

        <footer className={styles.footer}>
          <div className={styles.footerBrand}>
            <BrandMark />
            <span><strong>OMNIGAZE</strong><small>{copy.footer.tagline}</small></span>
          </div>
          <div className={styles.footerLinks}>
            <a href="#product">{copy.footer.product}</a>
            <a href="#intelligence">{copy.footer.intelligence}</a>
            <a href="#trust">{copy.footer.trust}</a>
            <a href="/dashboard">{copy.footer.dashboard}</a>
          </div>
          <p>{copy.footer.disclaimer}</p>
        </footer>
      </main>
    </MotionConfig>
  );
}

export function OmnigazeLanding(props: OmnigazeLandingProps) {
  return (
    <LandingLocaleProvider>
      <OmnigazeLandingContent {...props} />
    </LandingLocaleProvider>
  );
}

export default OmnigazeLanding;
