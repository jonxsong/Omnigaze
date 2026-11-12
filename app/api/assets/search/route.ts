import { AlpacaAssetProviderError } from "@/lib/providers/alpaca-assets";
import {
  AssetSearchService,
  getAssetSearchService,
} from "@/lib/services/asset-search";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const noStoreHeaders = { "Cache-Control": "no-store" };

type AssetSearch = Pick<AssetSearchService, "search">;

function invalidQuery(message: string) {
  return Response.json(
    { error: message, code: "invalid_query" },
    { status: 400, headers: noStoreHeaders },
  );
}

function unavailable(error: unknown) {
  const headers = new Headers(noStoreHeaders);
  if (
    error instanceof AlpacaAssetProviderError &&
    error.retryAfterSeconds !== undefined
  ) {
    headers.set(
      "Retry-After",
      String(Math.min(Math.max(error.retryAfterSeconds, 0), 86_400)),
    );
  }

  return Response.json(
    {
      error: "The asset catalog is temporarily unavailable.",
      code: "asset_catalog_unavailable",
    },
    { status: 503, headers },
  );
}

export function createAssetSearchHandler(service: AssetSearch) {
  return async function GET(request: Request) {
    const searchParams = new URL(request.url).searchParams;
    const query = searchParams.get("q")?.trim();
    if (
      !query ||
      query.length > 64 ||
      /[\u0000-\u001F\u007F]/.test(query)
    ) {
      return invalidQuery("q must contain between 1 and 64 searchable characters.");
    }

    const rawLimit = searchParams.get("limit");
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      return invalidQuery(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
    }
    const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return invalidQuery(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
    }

    try {
      const result = await service.search(query, limit);
      const cacheControl =
        result.meta.freshness.state === "fresh"
          ? "public, max-age=60, s-maxage=300, stale-while-revalidate=300"
          : "no-store";
      return Response.json(result, {
        headers: { "Cache-Control": cacheControl },
      });
    } catch (error) {
      return unavailable(error);
    }
  };
}

export async function GET(request: Request) {
  return createAssetSearchHandler(getAssetSearchService())(request);
}
