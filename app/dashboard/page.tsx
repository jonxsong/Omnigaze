import type { Metadata } from "next";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "@/app/chatgpt-auth";
import {
  MarketDashboard,
  type DashboardHolding,
  type DashboardInstrument,
} from "@/components/market-dashboard";
import { extractCanonicalSymbols } from "@/lib/api/personal-intelligence";
import type { CanonicalSymbol } from "@/lib/market-types";
import { getUserPortfolio } from "@/lib/repositories/portfolio";
import { listUserWatchlists } from "@/lib/repositories/watchlists";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard — Omnigaze",
  description:
    "Track your watchlist, inspect market-moving evidence, and review the evidence-backed Omnigaze View.",
};

function initialsFor(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OG";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export default async function DashboardPage() {
  const user = await getChatGPTUser();
  if (!user) {
    return (
      <MarketDashboard
        session={{
          isAuthenticated: false,
          signInPath: chatGPTSignInPath("/dashboard"),
        }}
      />
    );
  }

  const displayName = user.fullName ?? user.email.split("@")[0] ?? "Investor";
  const session = {
    isAuthenticated: true as const,
    displayName,
    initials: initialsFor(displayName),
    signOutPath: chatGPTSignOutPath("/dashboard"),
  };

  let accountWatchlist: {
    id: string;
    name: string;
    instruments: DashboardInstrument[];
  } | null = null;
  let accountSyncUnavailable = false;
  let accountHoldings: DashboardHolding[] | null = null;
  let accountPortfolioUnavailable = false;

  try {
    const watchlists = await listUserWatchlists(user.userId);
    const primary = watchlists.find((watchlist) => watchlist.isDefault) ?? watchlists[0];
    const canonicalSymbols = new Set(
      primary ? extractCanonicalSymbols([primary]) : [],
    );
    accountWatchlist = primary
      ? {
          id: primary.id,
          name: primary.name,
          instruments: primary.items.flatMap((item) => {
            if (!canonicalSymbols.has(item.symbolId as CanonicalSymbol)) return [];
            return [
              {
                id: item.symbolId as CanonicalSymbol,
                ticker: item.ticker,
                exchange: item.exchange,
                name: item.name,
                sector: null,
                currency: "USD" as const,
              },
            ];
          }),
        }
      : null;
  } catch {
    accountSyncUnavailable = true;
  }

  try {
    const portfolio = await getUserPortfolio(user.userId);
    accountHoldings = portfolio.holdings.map((holding) => ({
      symbolId: holding.symbolId,
      ticker: holding.ticker,
      exchange: holding.exchange,
      name: holding.name,
      quantity: holding.quantity,
      averageCost: holding.averageCost,
      totalCostBasis: holding.totalCostBasis,
      costCurrency: holding.costCurrency,
      quantityAsOf: holding.quantityAsOf,
      version: holding.version,
    }));
  } catch {
    accountPortfolioUnavailable = true;
  }

  return (
    <MarketDashboard
      session={session}
      accountWatchlist={accountWatchlist}
      accountSyncUnavailable={accountSyncUnavailable}
      accountHoldings={accountHoldings}
      accountPortfolioUnavailable={accountPortfolioUnavailable}
    />
  );
}
