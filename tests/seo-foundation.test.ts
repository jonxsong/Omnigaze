import { describe, expect, it } from "vitest";
import { metadata as dashboardMetadata } from "@/app/dashboard/layout";
import { metadata as onboardingMetadata } from "@/app/onboarding/layout";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  absoluteSiteUrl,
  publicSiteUrl,
  resolvePublicSiteUrl,
} from "@/lib/site-metadata";

describe("SEO discovery foundation", () => {
  it("accepts only credential-free public HTTPS origins", () => {
    expect(resolvePublicSiteUrl("https://omnigaze.app/path?q=1").toString()).toBe(
      "https://omnigaze.app/",
    );
    expect(resolvePublicSiteUrl("http://omnigaze.app").toString()).toBe(
      "https://omnigaze.perkyaisle4.chatgpt.site/",
    );
    expect(resolvePublicSiteUrl("https://127.0.0.1:3000").toString()).toBe(
      "https://omnigaze.perkyaisle4.chatgpt.site/",
    );
    expect(resolvePublicSiteUrl("https://user:secret@omnigaze.app").toString()).toBe(
      "https://omnigaze.perkyaisle4.chatgpt.site/",
    );
  });

  it("publishes only the public landing page in the sitemap", () => {
    expect(sitemap()).toEqual([
      {
        url: absoluteSiteUrl("/"),
        changeFrequency: "daily",
        priority: 1,
      },
    ]);
  });

  it("keeps account, API, and agent routes out of crawler scope", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/mcp",
          "/dashboard",
          "/onboarding",
          "/signin-with-chatgpt",
          "/signout-with-chatgpt",
          "/callback",
        ],
      },
      sitemap: absoluteSiteUrl("/sitemap.xml"),
      host: publicSiteUrl.origin,
    });
    expect(dashboardMetadata.robots).toMatchObject({
      index: false,
      follow: false,
      nocache: true,
    });
    expect(onboardingMetadata.robots).toEqual(dashboardMetadata.robots);
  });
});
