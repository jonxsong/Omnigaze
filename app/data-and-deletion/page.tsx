import type { Metadata } from "next";
import { chatGPTSignInPath, getChatGPTUser } from "@/app/chatgpt-auth";
import { LegalPage } from "@/components/legal/legal-page";

export const dynamic = "force-dynamic";

const dataDescription =
  "See exactly what Omnigaze stores and use the authenticated control to erase saved personal Omnigaze data.";

export const metadata: Metadata = {
  title: "Data & deletion",
  description: dataDescription,
  alternates: { canonical: "/data-and-deletion" },
  openGraph: {
    title: "Data & deletion | Omnigaze",
    description: dataDescription,
    url: "/data-and-deletion",
  },
  twitter: {
    title: "Data & deletion | Omnigaze",
    description: dataDescription,
  },
};

export default async function DataAndDeletionPage() {
  const user = await getChatGPTUser();

  return (
    <LegalPage
      kind="data"
      isAuthenticated={Boolean(user)}
      signInPath={chatGPTSignInPath("/data-and-deletion")}
    />
  );
}
