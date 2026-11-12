import type { Metadata } from "next";
import { MarketDashboard } from "@/components/market-dashboard";

export const metadata: Metadata = {
  title: "Dashboard — Omnigaze",
  description:
    "Track your watchlist, inspect market-moving evidence, and review the evidence-backed Omnigaze View.",
};

export default function DashboardPage() {
  return <MarketDashboard />;
}
