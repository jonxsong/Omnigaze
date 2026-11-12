import type { MetadataRoute } from "next";
import { absoluteSiteUrl } from "@/lib/site-metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  const publicPolicies = ["/privacy", "/terms", "/data-and-deletion"];

  return [
    {
      url: absoluteSiteUrl("/"),
      changeFrequency: "daily",
      priority: 1,
    },
    ...publicPolicies.map((path) => ({
      url: absoluteSiteUrl(path),
      changeFrequency: "monthly" as const,
      priority: 0.3,
    })),
  ];
}
