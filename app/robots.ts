import type { MetadataRoute } from "next";
import { absoluteSiteUrl, publicSiteUrl } from "@/lib/site-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
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
  };
}
