import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

const termsDescription =
  "Terms for the Omnigaze market-research alpha, including its research-only boundary and provider limitations.";

export const metadata: Metadata = {
  title: "Terms",
  description: termsDescription,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: "Terms | Omnigaze",
    description: termsDescription,
    url: "/terms",
  },
  twitter: { title: "Terms | Omnigaze", description: termsDescription },
};

export default function TermsPage() {
  return <LegalPage kind="terms" />;
}
