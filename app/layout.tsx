import type { Metadata } from "next";
import { publicSiteUrl, siteDescription } from "@/lib/site-metadata";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: publicSiteUrl,
  applicationName: "Omnigaze",
  title: {
    default: "Omnigaze — Your market, one intelligent view",
    template: "%s | Omnigaze",
  },
  description: siteDescription,
  keywords: [
    "market intelligence",
    "stock research",
    "portfolio dashboard",
    "financial news",
    "AI market analysis",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Omnigaze",
    title: "Omnigaze — Your market, one intelligent view",
    description: siteDescription,
    locale: "en_US",
    alternateLocale: ["zh_CN"],
  },
  twitter: {
    card: "summary",
    title: "Omnigaze — Your market, one intelligent view",
    description: siteDescription,
  },
  category: "finance",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Omnigaze",
  url: publicSiteUrl.toString(),
  description: siteDescription,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  inLanguage: ["en", "zh-CN"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
