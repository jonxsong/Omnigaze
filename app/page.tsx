import type { Metadata } from "next";
import { OmnigazeHowItWorks } from "@/components/landing/omnigaze-how-it-works";
import { OmnigazeLanding } from "@/components/landing/omnigaze-landing";

export const metadata: Metadata = {
  title: "See what moves your stocks",
  description:
    "Follow the stocks you care about with price context, licensed news, configured filings, company events, and an evidence-backed Omnigaze View. Explore the product in English or Chinese.",
  alternates: {
    canonical: "/",
  },
};

export default function LandingPage() {
  return <OmnigazeLanding howItWorks={<OmnigazeHowItWorks />} />;
}
