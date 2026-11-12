import type { Metadata } from "next";
import { OmnigazeHowItWorks } from "@/components/landing/omnigaze-how-it-works";
import { OmnigazeLanding } from "@/components/landing/omnigaze-landing";

export const metadata: Metadata = {
  title: "Omnigaze — See what moves your stocks",
  description:
    "AI-native market intelligence that connects price action, configured filings, licensed news, and company events into one evidence-backed view.",
};

export default function LandingPage() {
  return <OmnigazeLanding howItWorks={<OmnigazeHowItWorks />} />;
}
