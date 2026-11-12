"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Activity from "lucide-react/icons/activity";
import BellRing from "lucide-react/icons/bell-ring";
import BrainCircuit from "lucide-react/icons/brain-circuit";
import Check from "lucide-react/icons/check";
import ChevronDown from "lucide-react/icons/chevron-down";
import Database from "lucide-react/icons/database";
import ExternalLink from "lucide-react/icons/external-link";
import Eye from "lucide-react/icons/eye";
import FileCheck2 from "lucide-react/icons/file-check-2";
import FileText from "lucide-react/icons/file-text";
import LineChart from "lucide-react/icons/line-chart";
import ListPlus from "lucide-react/icons/list-plus";
import RadioTower from "lucide-react/icons/radio-tower";
import SearchCheck from "lucide-react/icons/search-check";
import ShieldCheck from "lucide-react/icons/shield-check";
import Sparkles from "lucide-react/icons/sparkles";
import { useState } from "react";
import { type LandingLocale, useLandingLocale } from "./landing-locale";
import styles from "./omnigaze-how-it-works.module.css";

const stepIcons = [ListPlus, RadioTower, BrainCircuit, SearchCheck];

const howCopy = {
  en: {
    kicker: "HOW OMNIGAZE WORKS",
    title: "From market noise to a",
    titleAccent: "view you can verify.",
    body: "Omnigaze turns the public signals around your watchlist into structured, source-linked context—then shows its work.",
    stepsAria: "How Omnigaze works",
    previewing: "Previewing step",
    workspace: "Omnigaze intelligence workspace",
    contextOnline: "Context online",
    steps: [
      {
        title: "Choose what you watch",
        description: "Build a personal market surface around the companies that matter to you. Omnigaze keeps every symbol, event, and view tied to your watchlist.",
        detail: "Personal watchlists",
      },
      {
        title: "Evidence refreshes with you",
        description: "As you open and refresh Omnigaze, market data, configured SEC filings, and licensed news enter one boundary to be timestamped, normalized, and source-labeled.",
        detail: "Request-time provider pipeline",
      },
      {
        title: "AI builds a grounded view",
        description: "Omnigaze connects new evidence to the company context, separates facts from inference, and synthesizes a concise view with confidence and unknowns.",
        detail: "Evidence-aware synthesis",
      },
      {
        title: "Verify, then act with context",
        description: "Inspect the underlying sources, save durable thesis evidence, and explicitly opt into in-app rules before making your own decision.",
        detail: "Source-first decisions · saved research · in-app rules",
      },
    ],
    watchlist: {
      eyebrow: "MY MARKET",
      title: "Core watchlist",
      add: "Add symbol",
      columns: ["Symbol", "Last", "Change"],
      tracked: "3 symbols tracked",
      footer: "Dashboard updates around your list",
    },
    ingestion: {
      eyebrow: "EVIDENCE PIPELINE",
      title: "Signals become structured context",
      checked: "Providers checked",
      marketData: "Market data",
      quoteObserved: "Quote observed",
      licensedNews: "Licensed news",
      articlePublished: "Article published",
      accepted: "10-Q accepted",
      normalized: "NORMALIZED",
      filingReceived: "Quarterly filing received",
      symbol: "Symbol",
      published: "Published",
      source: "Source",
      secFiling: "SEC filing",
      note: "Every event retains its provider, timestamp, and source URL.",
    },
    synthesis: {
      title: "Evidence-backed interpretation",
      ai: "AI synthesis",
      nearTerm: "Near-term view",
      mixed: "Constructive · mixed",
      headline: "Demand remains durable, while the valuation leaves less room for execution risk.",
      body: "Recent filings support continued data-center momentum. The strongest counterweight is the pace of spending required to sustain growth.",
      confidence: "evidence confidence",
      supporting: "Supporting",
      supportingDetail: "Data-center revenue trend",
      counterweight: "Counterweight",
      counterweightDetail: "Infrastructure investment cycle",
      unknown: "Unknown",
      unknownDetail: "Demand durability after launch",
      fact: "Fact",
      derived: "Derived",
      inference: "Omnigaze inference",
    },
    verify: {
      eyebrow: "VERIFY THE VIEW",
      title: "Trace every claim to evidence",
      sources: "3 sources",
      inference: "OMNIGAZE INFERENCE",
      claim: "Enterprise demand remains the primary near-term driver.",
      support: "Supported by two disclosed metrics and one management statement.",
      filing: "FY 2026 Form 10-Q",
      filingMeta: "MD&A · page 38",
      revenue: "Reported revenue series",
      revenueMeta: "Derived · four quarters",
      release: "Earnings release",
      releaseMeta: "Company IR · verified",
      open: "Open filing",
      thesis: "Thesis · saved",
      alerts: "Alerts · in app",
    },
  },
  "zh-CN": {
    kicker: "OMNIGAZE 工作原理",
    title: "从市场噪声走向",
    titleAccent: "可核验的观点。",
    body: "Omnigaze 将关注列表周围的公开信号转化为结构化、可追溯来源的上下文，并展示推理依据。",
    stepsAria: "Omnigaze 工作原理",
    previewing: "正在预览步骤",
    workspace: "Omnigaze 智能工作台",
    contextOnline: "上下文已就绪",
    steps: [
      {
        title: "选择你的关注标的",
        description: "围绕你关心的公司构建个人市场界面。Omnigaze 会让每个代码、事件与观点始终关联到你的关注列表。",
        detail: "个人关注列表",
      },
      {
        title: "证据随使用刷新",
        description: "当你打开或刷新 Omnigaze 时，市场数据、已配置的 SEC 监管文件与授权新闻会进入统一边界，添加时间戳、完成标准化并标注来源。",
        detail: "按请求运行的数据提供方管线",
      },
      {
        title: "AI 构建有依据的观点",
        description: "Omnigaze 将新证据与公司上下文连接，区分事实与推断，并综合为带有置信度和未知项的简明观点。",
        detail: "证据感知综合研判",
      },
      {
        title: "核验后，带着上下文行动",
        description: "决策前检查底层来源、长期保存投资逻辑证据，并自主开启应用内规则。",
        detail: "来源优先的决策 · 已保存研究 · 应用内规则",
      },
    ],
    watchlist: {
      eyebrow: "我的市场",
      title: "核心关注列表",
      add: "添加代码",
      columns: ["代码", "最新价", "涨跌幅"],
      tracked: "已关注 3 个代码",
      footer: "仪表盘围绕你的列表更新",
    },
    ingestion: {
      eyebrow: "证据管线",
      title: "信号转化为结构化上下文",
      checked: "已检查数据提供方",
      marketData: "市场数据",
      quoteObserved: "已观察到行情",
      licensedNews: "授权新闻",
      articlePublished: "文章已发布",
      accepted: "已接收 10-Q",
      normalized: "已标准化",
      filingReceived: "已收到季度监管文件",
      symbol: "代码",
      published: "发布时间",
      source: "来源",
      secFiling: "SEC 监管文件",
      note: "每个事件都会保留数据提供方、时间戳和来源 URL。",
    },
    synthesis: {
      title: "有证据支撑的解读",
      ai: "AI 综合研判",
      nearTerm: "短期观点",
      mixed: "偏积极 · 多空交织",
      headline: "需求仍具韧性，但当前估值留给执行风险的空间更小。",
      body: "近期监管文件支持数据中心动能延续。最主要的制衡因素，是维持增长所需的投入速度。",
      confidence: "证据置信度",
      supporting: "支持因素",
      supportingDetail: "数据中心收入趋势",
      counterweight: "制衡因素",
      counterweightDetail: "基础设施投资周期",
      unknown: "未知项",
      unknownDetail: "发布后的需求持续性",
      fact: "事实",
      derived: "衍生观察",
      inference: "Omnigaze 推断",
    },
    verify: {
      eyebrow: "核验观点",
      title: "将每项论断追溯至证据",
      sources: "3 个来源",
      inference: "OMNIGAZE 推断",
      claim: "企业需求仍是短期内的主要驱动因素。",
      support: "由两项已披露指标与一项管理层陈述支持。",
      filing: "FY 2026 Form 10-Q",
      filingMeta: "MD&A · 第 38 页",
      revenue: "已报告收入序列",
      revenueMeta: "衍生观察 · 四个季度",
      release: "财报新闻稿",
      releaseMeta: "公司投资者关系 · 已核验",
      open: "打开监管文件",
      thesis: "投资逻辑 · 已保存",
      alerts: "提醒 · 应用内",
    },
  },
} satisfies Record<LandingLocale, object>;

type HowCopy = (typeof howCopy)[LandingLocale];

function WatchlistPreview({ copy }: { copy: HowCopy["watchlist"] }) {
  const rows = [
    { ticker: "NVDA", name: "NVIDIA", price: "$182.41", move: "+2.84%", positive: true },
    { ticker: "MSFT", name: "Microsoft", price: "$517.62", move: "−0.38%", positive: false },
    { ticker: "AMD", name: "Advanced Micro Devices", price: "$257.18", move: "+1.71%", positive: true },
  ];

  return (
    <div className={styles.previewScene}>
      <div className={styles.sceneHeading}>
        <div>
          <span className={styles.sceneEyebrow}>{copy.eyebrow}</span>
          <h3>{copy.title}</h3>
        </div>
        <span className={styles.miniButton} aria-hidden="true"><ListPlus size={14} /> {copy.add}</span>
      </div>

      <div className={styles.watchlistTable}>
        <div className={styles.tableHeader} aria-hidden="true">
          {copy.columns.map((column) => <span key={column}>{column}</span>)}
        </div>
        {rows.map((row, index) => (
          <div className={[styles.watchlistRow, index === 0 ? styles.selectedRow : ""].join(" ")} key={row.ticker}>
            <span className={styles.companyCell}>
              <span className={styles.companyMark}>{row.ticker[0]}</span>
              <span><strong>{row.ticker}</strong><small>{row.name}</small></span>
            </span>
            <strong>{row.price}</strong>
            <span className={row.positive ? styles.positive : styles.negative}>{row.move}</span>
          </div>
        ))}
      </div>

      <div className={styles.sceneFooter}>
        <Eye size={14} /> <span>{copy.tracked}</span>
        <span className={styles.footerMeta}>{copy.footer}</span>
      </div>
    </div>
  );
}

function IngestionPreview({ copy }: { copy: HowCopy["ingestion"] }) {
  return (
    <div className={styles.previewScene}>
      <div className={styles.sceneHeading}>
        <div>
          <span className={styles.sceneEyebrow}>{copy.eyebrow}</span>
          <h3>{copy.title}</h3>
        </div>
        <span className={styles.healthBadge}><span /> {copy.checked}</span>
      </div>

      <div className={styles.pipeline}>
        <div className={styles.sourceStack}>
          <div><FileText size={16} /><span><strong>SEC EDGAR</strong><small>{copy.accepted}</small></span></div>
          <div><Activity size={16} /><span><strong>{copy.marketData}</strong><small>{copy.quoteObserved}</small></span></div>
          <div><RadioTower size={16} /><span><strong>{copy.licensedNews}</strong><small>{copy.articlePublished}</small></span></div>
        </div>

        <div className={styles.pipelineFlow} aria-hidden="true">
          <span /><span /><span />
          <Database size={20} />
        </div>

        <div className={styles.normalizedCard}>
          <span className={styles.normalizedLabel}><Check size={12} /> {copy.normalized}</span>
          <strong>{copy.filingReceived}</strong>
          <dl>
            <div><dt>{copy.symbol}</dt><dd>NASDAQ:NVDA</dd></div>
            <div><dt>{copy.published}</dt><dd>16:06:21 UTC</dd></div>
            <div><dt>{copy.source}</dt><dd>{copy.secFiling}</dd></div>
          </dl>
        </div>
      </div>

      <div className={styles.pipelineNote}><ShieldCheck size={14} /> {copy.note}</div>
    </div>
  );
}

function SynthesisPreview({ copy }: { copy: HowCopy["synthesis"] }) {
  return (
    <div className={styles.previewScene}>
      <div className={styles.sceneHeading}>
        <div>
          <span className={styles.sceneEyebrow}>OMNIGAZE VIEW</span>
          <h3>{copy.title}</h3>
        </div>
        <span className={styles.aiBadge}><Sparkles size={13} /> {copy.ai}</span>
      </div>

      <div className={styles.synthesisGrid}>
        <div className={styles.viewCard}>
          <div className={styles.viewTopline}>
            <span>{copy.nearTerm}</span>
            <span className={styles.mixedBadge}>{copy.mixed}</span>
          </div>
          <h4>{copy.headline}</h4>
          <p>{copy.body}</p>
          <div className={styles.confidenceTrack}>
            <span><strong>82%</strong> {copy.confidence}</span>
            <span className={styles.track}><i /></span>
          </div>
        </div>

        <div className={styles.driverCards}>
          <div><span className={styles.positiveDot} /><span><strong>{copy.supporting}</strong><small>{copy.supportingDetail}</small></span></div>
          <div><span className={styles.warningDot} /><span><strong>{copy.counterweight}</strong><small>{copy.counterweightDetail}</small></span></div>
          <div><span className={styles.neutralDot} /><span><strong>{copy.unknown}</strong><small>{copy.unknownDetail}</small></span></div>
        </div>
      </div>

      <div className={styles.factLegend}>
        <span><i className={styles.factDot} /> {copy.fact}</span>
        <span><i className={styles.derivedDot} /> {copy.derived}</span>
        <span><i className={styles.inferenceDot} /> {copy.inference}</span>
      </div>
    </div>
  );
}

function VerifyPreview({ copy }: { copy: HowCopy["verify"] }) {
  return (
    <div className={styles.previewScene}>
      <div className={styles.sceneHeading}>
        <div>
          <span className={styles.sceneEyebrow}>{copy.eyebrow}</span>
          <h3>{copy.title}</h3>
        </div>
        <span className={styles.verifiedBadge}><FileCheck2 size={13} /> {copy.sources}</span>
      </div>

      <div className={styles.verifyLayout}>
        <div className={styles.claimCard}>
          <span className={styles.claimLabel}>{copy.inference}</span>
          <h4>{copy.claim}</h4>
          <p>{copy.support}</p>
        </div>

        <div className={styles.sourceList}>
          <div><FileText size={15} /><span><strong>{copy.filing}</strong><small>{copy.filingMeta}</small></span><ExternalLink size={13} /></div>
          <div><LineChart size={15} /><span><strong>{copy.revenue}</strong><small>{copy.revenueMeta}</small></span><ExternalLink size={13} /></div>
          <div><FileCheck2 size={15} /><span><strong>{copy.release}</strong><small>{copy.releaseMeta}</small></span><ExternalLink size={13} /></div>
        </div>
      </div>

      <div className={styles.actionRow}>
        <span aria-hidden="true"><ExternalLink size={13} /> {copy.open}</span>
        <span aria-hidden="true"><FileCheck2 size={13} /> {copy.thesis}</span>
        <span aria-hidden="true"><BellRing size={13} /> {copy.alerts}</span>
      </div>
    </div>
  );
}

export function OmnigazeHowItWorks() {
  const [activeStep, setActiveStep] = useState(0);
  const reduceMotion = useReducedMotion();
  const { locale } = useLandingLocale();
  const copy = howCopy[locale];
  const previews = [
    <WatchlistPreview copy={copy.watchlist} key="watchlist" />,
    <IngestionPreview copy={copy.ingestion} key="ingestion" />,
    <SynthesisPreview copy={copy.synthesis} key="synthesis" />,
    <VerifyPreview copy={copy.verify} key="verify" />,
  ];

  return (
    <section className={styles.section} data-locale={locale} aria-labelledby="omnigaze-how-it-works-title">
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.inner}>
        <header className={styles.heading}>
          <span className={styles.kicker}><Sparkles size={14} /> {copy.kicker}</span>
          <h2 id="omnigaze-how-it-works-title">{copy.title} <span>{copy.titleAccent}</span></h2>
          <p>{copy.body}</p>
        </header>

        <div className={styles.layout}>
          <ol className={styles.steps} aria-label={copy.stepsAria}>
            {copy.steps.map((step, index) => {
              const Icon = stepIcons[index] ?? ListPlus;
              const active = activeStep === index;
              const contentId = "omnigaze-step-" + (index + 1);
              const triggerId = "omnigaze-step-trigger-" + (index + 1);

              return (
                <li className={active ? styles.activeStep : undefined} key={step.title}>
                  <button
                    id={triggerId}
                    type="button"
                    aria-expanded={active}
                    aria-controls={contentId}
                    onClick={() => setActiveStep(index)}
                  >
                    <span className={styles.stepNumber}>0{index + 1}</span>
                    <span className={styles.stepTitle}><Icon size={17} />{step.title}</span>
                    <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
                  </button>

                  <AnimatePresence initial={false}>
                    {active && (
                      <motion.div
                        id={contentId}
                        role="region"
                        aria-labelledby={triggerId}
                        className={styles.stepContent}
                        initial={reduceMotion ? { opacity: 1 } : { height: 0, opacity: 0 }}
                        animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.24, ease: "easeOut" }}
                      >
                        <p>{step.description}</p>
                        <span><Check size={12} />{step.detail}</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ol>

          <p className={styles.srOnly} aria-live="polite">
            {copy.previewing} {activeStep + 1}: {copy.steps[activeStep]?.title}
          </p>
          <div className={styles.preview}>
            <div className={styles.previewBar} aria-hidden="true">
              <span className={styles.windowDots}><i /><i /><i /></span>
              <span>{copy.workspace}</span>
              <span className={styles.previewStatus}><i /> {copy.contextOnline}</span>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                className={styles.previewBody}
                key={activeStep}
                initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 12, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.995 }}
                transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                {previews[activeStep]}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
