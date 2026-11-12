import type { Metadata } from "next";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "@/app/chatgpt-auth";
import { MarketDashboard } from "@/components/market-dashboard";
import { extractCanonicalSymbols } from "@/lib/api/personal-intelligence";
import type { CanonicalSymbol } from "@/lib/market-types";
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
    symbols: CanonicalSymbol[];
  } | null = null;
  let accountSyncUnavailable = false;

  try {
    const watchlists = await listUserWatchlists(user.userId);
    const primary = watchlists.find((watchlist) => watchlist.isDefault) ?? watchlists[0];
    accountWatchlist = primary
      ? {
          id: primary.id,
          name: primary.name,
          symbols: extractCanonicalSymbols([primary]),
        }
      : null;
  } catch {
    accountSyncUnavailable = true;
  }

  return (
    <MarketDashboard
      session={session}
      accountWatchlist={accountWatchlist}
      accountSyncUnavailable={accountSyncUnavailable}
    />
  );
}
