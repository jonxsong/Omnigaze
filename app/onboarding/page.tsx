import type { Metadata } from "next";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { AppLocaleProvider } from "@/components/app-locale";
import { OmnigazeOnboarding } from "@/components/onboarding/omnigaze-onboarding";

export const metadata: Metadata = {
  title: "Personalize your market — Omnigaze",
  description:
    "Build a focused watchlist and choose the research context Omnigaze should prioritize.",
};

export default async function OnboardingPage() {
  const user = await getChatGPTUser();
  return (
    <AppLocaleProvider>
      <OmnigazeOnboarding isAuthenticated={Boolean(user)} />
    </AppLocaleProvider>
  );
}
