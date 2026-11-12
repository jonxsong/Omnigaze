import type { CanonicalSymbol } from "@/lib/market-types";
import type { DailyBriefEvidenceItem } from "@/lib/services/personal-today-evidence";

export const DAILY_BRIEF_CACHE_NAMESPACE = "omnigaze_daily_brief_v1";
const sha256Pattern = /^[a-f0-9]{64}$/;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function boundedIdentity(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function validBriefDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
  );
}

function validTimestamp(value: string) {
  return Number.isFinite(Date.parse(value));
}

function validSourceUrl(value: string | null) {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export async function fingerprintDailyBriefWatchlist(
  symbols: readonly CanonicalSymbol[],
) {
  const canonical = [
    ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase())),
  ].sort();
  if (
    canonical.length === 0 ||
    canonical.length > 100 ||
    canonical.some((symbol) => !canonicalSymbolPattern.test(symbol))
  ) {
    throw new Error("invalid_watchlist");
  }
  return sha256Hex(
    `${DAILY_BRIEF_CACHE_NAMESPACE}:watchlist\0${JSON.stringify(canonical)}`,
  );
}

export async function fingerprintDailyBriefEvidence(
  evidence: readonly DailyBriefEvidenceItem[],
) {
  if (evidence.length === 0 || evidence.length > 12) {
    throw new Error("invalid_evidence");
  }
  const ids = new Set<string>();
  const canonical = evidence
    .map((item) => {
      const symbolIds = [...new Set(item.symbolIds)].sort();
      if (
        !item.id ||
        item.id.length > 300 ||
        !item.eventId ||
        item.eventId.length > 256 ||
        ids.has(item.id) ||
        symbolIds.length === 0 ||
        symbolIds.length > 12 ||
        symbolIds.some((symbol) => !canonicalSymbolPattern.test(symbol)) ||
        !item.source ||
        item.source.length > 200 ||
        !item.headline ||
        item.headline.length > 500 ||
        !validTimestamp(item.publishedAt) ||
        (item.providerUpdatedAt !== null &&
          !validTimestamp(item.providerUpdatedAt)) ||
        !validSourceUrl(item.sourceUrl)
      ) {
        throw new Error("invalid_evidence");
      }
      ids.add(item.id);
      return {
        id: item.id,
        eventId: item.eventId,
        symbolIds,
        source: item.source,
        sourceKind: item.sourceKind,
        headline: item.headline,
        summary: item.summary,
        publishedAt: item.publishedAt,
        providerUpdatedAt: item.providerUpdatedAt,
        sourceUrl: item.sourceUrl,
        materiality: item.materiality,
        category: item.category ?? null,
        claimStatus: item.claimStatus ?? null,
        causalLink: item.causalLink ?? null,
        topicTags: [...new Set(item.topicTags)].sort(),
        isControversial: item.isControversial,
      };
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return sha256Hex(
    `${DAILY_BRIEF_CACHE_NAMESPACE}:evidence\0${JSON.stringify(canonical)}`,
  );
}

export async function buildDailyBriefCacheKey(input: {
  promptVersion: string;
  modelKey: string;
  briefDate: string;
  watchlistFingerprint: string;
  evidenceFingerprint: string;
}) {
  const promptVersion = boundedIdentity(input.promptVersion, "prompt_version");
  const modelKey = boundedIdentity(input.modelKey, "model_key");
  if (
    !validBriefDate(input.briefDate) ||
    !sha256Pattern.test(input.watchlistFingerprint) ||
    !sha256Pattern.test(input.evidenceFingerprint)
  ) {
    throw new Error("invalid_cache_identity");
  }
  return sha256Hex(
    [
      DAILY_BRIEF_CACHE_NAMESPACE,
      promptVersion,
      modelKey,
      input.briefDate,
      input.watchlistFingerprint,
      input.evidenceFingerprint,
    ].join("\0"),
  );
}

export async function createDailyBriefCacheIdentity(input: {
  promptVersion: string;
  modelKey: string;
  briefDate: string;
  trackedSymbols: readonly CanonicalSymbol[];
  evidence: readonly DailyBriefEvidenceItem[];
}) {
  const [watchlistFingerprint, evidenceFingerprint] = await Promise.all([
    fingerprintDailyBriefWatchlist(input.trackedSymbols),
    fingerprintDailyBriefEvidence(input.evidence),
  ]);
  const cacheKey = await buildDailyBriefCacheKey({
    promptVersion: input.promptVersion,
    modelKey: input.modelKey,
    briefDate: input.briefDate,
    watchlistFingerprint,
    evidenceFingerprint,
  });
  return { cacheKey, watchlistFingerprint, evidenceFingerprint };
}
