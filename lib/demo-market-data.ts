import type {
  CanonicalSymbol,
  Direction,
  Evidence,
  IntelligenceEvent,
  MarketPoint,
  StockWorkspace,
} from "./market-types";

type SeedStock = {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
  sector: string;
  price: number;
  previousClose: number;
  volume: number;
  marketCap: string;
  stance: StockWorkspace["view"]["stance"];
  confidence: number;
  headline: string;
  summary: string;
  whyNow: string;
  direction: Direction;
};

const seeds: SeedStock[] = [
  {
    id: "NASDAQ:NVDA",
    ticker: "NVDA",
    exchange: "NASDAQ",
    name: "NVIDIA Corporation",
    sector: "Semiconductors",
    price: 159.37,
    previousClose: 173.85,
    volume: 68_420_000,
    marketCap: "$4.61T",
    stance: "mixed",
    confidence: 0.78,
    headline: "Governance scrutiny is dominating near-term attention",
    summary:
      "A board investigation and questions about executive continuity are adding governance risk, while the underlying demand evidence remains a separate fundamental signal.",
    whyNow:
      "Shares moved sharply around new reporting concerning CEO Jensen Huang. The timing is observable; Omnigaze does not treat it as proof that one controversy solely caused the move.",
    direction: "negative",
  },
  {
    id: "NASDAQ:MSFT",
    ticker: "MSFT",
    exchange: "NASDAQ",
    name: "Microsoft Corporation",
    sector: "Software",
    price: 519.64,
    previousClose: 521.78,
    volume: 14_280_000,
    marketCap: "$3.86T",
    stance: "mixed",
    confidence: 0.76,
    headline: "Cloud momentum is intact, but AI infrastructure spend is rising",
    summary:
      "Azure demand supports the growth case while capital intensity adds pressure to near-term free-cash-flow expectations.",
    whyNow:
      "Shares are modestly lower as the market weighs accelerating cloud growth against a larger infrastructure investment cycle.",
    direction: "mixed",
  },
  {
    id: "NASDAQ:AMD",
    ticker: "AMD",
    exchange: "NASDAQ",
    name: "Advanced Micro Devices",
    sector: "Semiconductors",
    price: 241.16,
    previousClose: 237.05,
    volume: 24_910_000,
    marketCap: "$391B",
    stance: "bullish",
    confidence: 0.72,
    headline: "AI accelerator expectations are moving higher",
    summary:
      "Partner commentary supports improving accelerator adoption, although execution risk remains elevated against a dominant incumbent.",
    whyNow:
      "The move follows a cluster of partner announcements and upward revisions to datacenter revenue expectations.",
    direction: "positive",
  },
  {
    id: "NASDAQ:AAPL",
    ticker: "AAPL",
    exchange: "NASDAQ",
    name: "Apple Inc.",
    sector: "Consumer Electronics",
    price: 276.24,
    previousClose: 275.69,
    volume: 42_180_000,
    marketCap: "$4.08T",
    stance: "neutral",
    confidence: 0.68,
    headline: "Services resilience offsets muted device-cycle signals",
    summary:
      "Services growth remains supportive, but current public evidence does not yet show a decisive acceleration in the hardware replacement cycle.",
    whyNow:
      "The stock is little changed while investors wait for clearer demand evidence from the next product and earnings cycle.",
    direction: "unclear",
  },
  {
    id: "NASDAQ:TSLA",
    ticker: "TSLA",
    exchange: "NASDAQ",
    name: "Tesla, Inc.",
    sector: "Automobiles",
    price: 411.72,
    previousClose: 419.66,
    volume: 61_230_000,
    marketCap: "$1.37T",
    stance: "bearish",
    confidence: 0.71,
    headline: "Delivery uncertainty is outweighing longer-term autonomy optimism",
    summary:
      "Near-term delivery and pricing evidence is soft, while the most constructive autonomy assumptions remain difficult to verify.",
    whyNow:
      "Shares are under pressure following new regional registration data and another round of delivery-estimate reductions.",
    direction: "negative",
  },
];

const timeframeConfig = {
  "1D": { points: 30, amplitude: 0.009 },
  "1W": { points: 35, amplitude: 0.025 },
  "1M": { points: 38, amplitude: 0.055 },
  "3M": { points: 42, amplitude: 0.1 },
  "1Y": { points: 48, amplitude: 0.22 },
} as const;

function hash(text: string) {
  return [...text].reduce((total, char) => total + char.charCodeAt(0), 0);
}

function createSeries(
  ticker: string,
  price: number,
  range: keyof typeof timeframeConfig,
): MarketPoint[] {
  const { points, amplitude } = timeframeConfig[range];
  const seed = hash(`${ticker}-${range}`);
  const bias = ((seed % 7) - 2) / 750;

  const anchorTime = Date.parse("2026-11-12T05:45:00.000Z");

  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const wave = Math.sin(index * 0.73 + seed) * amplitude * 0.36;
    const secondary = Math.cos(index * 0.31 + seed / 3) * amplitude * 0.18;
    const trend = (progress - 0.72) * (amplitude * 0.72 + bias);
    const pointPrice = price * (1 + wave + secondary + trend);

    return {
      timestamp: new Date(anchorTime - (points - index) * 60 * 60 * 1000).toISOString(),
      label: range === "1D" ? `${9 + Math.floor(index / 5)}:${index % 5}0` : `${index + 1}`,
      price: Number(pointPrice.toFixed(2)),
      volume: Math.round(900_000 + Math.abs(Math.sin(index + seed)) * 4_800_000),
    };
  });
}

function buildEvidence(seed: SeedStock): Evidence[] {
  const evidence: Evidence[] = [
    {
      id: `${seed.ticker}-evidence-filing`,
      classification: "fact",
      title: `${seed.name} quarterly filing`,
      publisher: "SEC EDGAR",
      publishedAt: "2026-11-10T20:05:00.000Z",
      url: "https://www.sec.gov/edgar/search/",
      locator: "Management discussion and analysis",
      excerpt: "Illustrative foundation data — source ingestion will replace this fixture.",
    },
    {
      id: `${seed.ticker}-evidence-market`,
      classification: "derived",
      title: "Price and relative-volume observation",
      publisher: "Omnigaze market pipeline",
      publishedAt: "2026-11-12T05:45:00.000Z",
      url: null,
      locator: "Regular session",
    },
    {
      id: `${seed.ticker}-evidence-view`,
      classification: "inference",
      title: "Omnigaze synthesis",
      publisher: "Omnigaze",
      publishedAt: "2026-11-12T05:46:00.000Z",
      url: null,
      locator: "Near-term view",
    },
  ];

  if (seed.ticker === "NVDA") {
    evidence.unshift(
      {
        id: "NVDA-evidence-board-investigation",
        classification: "fact",
        title: "NVIDIA board announces an independent investigation",
        publisher: "NVIDIA Investor Relations",
        publishedAt: "2026-11-08T21:41:00.000Z",
        url: "https://investor.nvidia.com/news/press-release-details/2026/Statement-from-NVIDIA-Board-of-Directors/default.aspx",
        locator: "Statement from NVIDIA Board of Directors",
        excerpt:
          "The company confirmed that its board initiated an independent investigation following reporting about a foreign intelligence effort targeting its CEO.",
      },
      {
        id: "NVDA-evidence-governance-market-response",
        classification: "fact",
        title: "Market coverage records a sharp move around governance reports",
        publisher: "Associated Press",
        publishedAt: "2026-11-12T04:11:24.000Z",
        url: "https://apnews.com/article/8bf08407eafe1655ed73112f7494029a",
        locator: "Market and company-governance coverage",
        excerpt:
          "Reporting documented a sharp after-hours share move while new details and board deliberations were being reported.",
      },
    );
  }

  return evidence;
}

function buildEvents(seed: SeedStock): IntelligenceEvent[] {
  const events: IntelligenceEvent[] = [
    {
      id: `${seed.ticker}-event-primary`,
      symbolId: seed.id,
      headline: seed.headline,
      summary: seed.whyNow,
      occurredAt: "2026-11-12T05:39:00.000Z",
      materiality: "high",
      possibleDirection: seed.direction,
      status: "verified",
      evidenceIds: [`${seed.ticker}-evidence-filing`, `${seed.ticker}-evidence-market`],
      category: "market",
    },
    {
      id: `${seed.ticker}-event-filing`,
      symbolId: seed.id,
      headline: "New disclosure mapped to the current investment thesis",
      summary:
        "Omnigaze identified one supporting signal and one unresolved risk in the latest public materials.",
      occurredAt: "2026-11-10T20:05:00.000Z",
      materiality: "medium",
      possibleDirection: "mixed",
      status: "verified",
      evidenceIds: [`${seed.ticker}-evidence-filing`],
      category: "filing",
    },
  ];

  if (seed.ticker === "NVDA") {
    events.unshift({
      id: "NVDA-event-governance-scrutiny",
      symbolId: seed.id,
      headline: "Board investigation elevates executive and governance risk",
      summary:
        "NVIDIA confirmed an independent board investigation, and subsequent reporting coincided with sharp share moves. This is a temporal association and plausible contributor—not proof that the controversy solely caused the decline.",
      occurredAt: "2026-11-12T04:11:24.000Z",
      materiality: "critical",
      possibleDirection: "negative",
      status: "preliminary",
      evidenceIds: [
        "NVDA-evidence-board-investigation",
        "NVDA-evidence-governance-market-response",
      ],
      category: "governance",
      claimStatus: "official-investigation",
      causalLink: "plausible-contributor",
      topicTags: ["executive conduct", "board oversight", "succession risk"],
      sourceCount: 2,
    });
  }

  return events;
}

export const stockWorkspaces: StockWorkspace[] = seeds.map((seed) => {
  const evidence = buildEvidence(seed);
  const change = seed.price - seed.previousClose;
  const changePercent = (change / seed.previousClose) * 100;

  return {
    instrument: {
      id: seed.id,
      ticker: seed.ticker,
      exchange: seed.exchange,
      name: seed.name,
      sector: seed.sector,
      currency: "USD",
    },
    snapshot: {
      symbolId: seed.id,
      asOf: "2026-11-12T05:45:00.000Z",
      session: "closed",
      price: seed.price,
      previousClose: seed.previousClose,
      change: Number(change.toFixed(2)),
      changePercent: Number(changePercent.toFixed(2)),
      volume: seed.volume,
      marketCap: seed.marketCap,
      isDelayed: true,
      delaySeconds: 900,
      provider: "Omnigaze demo fixture",
      marketCoverage: "fixture",
    },
    chart: {
      "1D": createSeries(seed.ticker, seed.price, "1D"),
      "1W": createSeries(seed.ticker, seed.price, "1W"),
      "1M": createSeries(seed.ticker, seed.price, "1M"),
      "3M": createSeries(seed.ticker, seed.price, "3M"),
      "1Y": createSeries(seed.ticker, seed.price, "1Y"),
    },
    events: buildEvents(seed),
    evidence,
    view: {
      symbolId: seed.id,
      generatedAt: "2026-11-12T05:46:00.000Z",
      horizon: "near-term",
      stance: seed.stance,
      confidence: seed.confidence,
      summary: seed.summary,
      whyNow: seed.whyNow,
      drivers: [
        {
          label: "Primary catalyst",
          direction: seed.direction,
          explanation: seed.headline,
          evidenceIds:
            seed.ticker === "NVDA"
              ? [
                  "NVDA-evidence-board-investigation",
                  "NVDA-evidence-governance-market-response",
                ]
              : [`${seed.ticker}-evidence-filing`],
        },
        {
          label: "Market confirmation",
          direction: change >= 0 ? "positive" : "negative",
          explanation: `${Math.abs(changePercent).toFixed(1)}% move versus the prior close with elevated attention.`,
          evidenceIds: [`${seed.ticker}-evidence-market`],
        },
      ],
      unknowns: [
        "Whether the current move persists after the next material disclosure.",
        "How much of the price action is company-specific versus sector-wide.",
        ...(seed.ticker === "NVDA"
          ? [
              "The investigation outcome and any implications for executive continuity.",
              "How much of the observed move is attributable to governance news versus other market factors.",
            ]
          : []),
      ],
      dataCutoff: "2026-11-12T05:45:00.000Z",
      disclaimer: "Research support only. This is not investment advice.",
    },
  };
});

export const workspaceBySymbol = new Map(
  stockWorkspaces.map((workspace) => [workspace.instrument.id, workspace]),
);

export const defaultWatchlist = stockWorkspaces.map(
  (workspace) => workspace.instrument.id,
);

export const allEvents = stockWorkspaces
  .flatMap((workspace) => workspace.events)
  .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
