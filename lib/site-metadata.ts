const DEFAULT_PUBLIC_SITE_ORIGIN =
  "https://omnigaze.jonzhang.dev";

const NON_PUBLIC_HOSTS = new Set(["localhost", "0.0.0.0", "127.0.0.1", "::1"]);

function isPublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    NON_PUBLIC_HOSTS.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return false;
  }

  const octets = normalized.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    const [first = -1, second = -1] = octets;
    if (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return false;
    }
  }

  return normalized.includes(".");
}

export function resolvePublicSiteUrl(value?: string) {
  try {
    const candidate = new URL(value?.trim() || DEFAULT_PUBLIC_SITE_ORIGIN);
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      !isPublicHostname(candidate.hostname)
    ) {
      throw new Error("The public Site URL must be a credential-free HTTPS origin.");
    }

    return new URL(candidate.origin);
  } catch {
    return new URL(DEFAULT_PUBLIC_SITE_ORIGIN);
  }
}

export const publicSiteUrl = resolvePublicSiteUrl(
  process.env.NEXT_PUBLIC_OMNIGAZE_URL,
);

export const siteDescription =
  "Evidence-backed market intelligence for the stocks you follow, with explicit freshness, source context, and a bilingual English and Chinese product tour.";

export function absoluteSiteUrl(pathname: string) {
  return new URL(pathname, publicSiteUrl).toString();
}
