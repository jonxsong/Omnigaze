import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

const privacyDescription =
  "How Omnigaze handles browser data, signed-in records, market evidence, providers, and AI-assisted research.";

export const metadata: Metadata = {
  title: "Privacy",
  description: privacyDescription,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy | Omnigaze",
    description: privacyDescription,
    url: "/privacy",
  },
  twitter: { title: "Privacy | Omnigaze", description: privacyDescription },
};

export default function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}
