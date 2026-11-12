import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omnigaze — Your market, one intelligent view",
  description:
    "Track the companies you care about and understand the evidence moving them.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
