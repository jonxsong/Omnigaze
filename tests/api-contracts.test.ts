import { describe, expect, it } from "vitest";
import { createHealthHandler } from "@/app/api/health/route";
import { GET as getIntelligence } from "@/app/api/intelligence/route";
import { GET as getSnapshot } from "@/app/api/market/snapshot/route";

describe("browser API response contracts", () => {
  it("returns a stable snapshot envelope with freshness metadata", async () => {
    const response = await getSnapshot(
      new Request("https://omnigaze.test/api/market/snapshot?symbol=nasdaq:nvda"),
    );
    const body = (await response.json()) as {
      data: { symbolId: string; asOf: string; provider: string; isDelayed: boolean };
      meta: {
        dataMode: string;
        providerCoverage: string;
        freshness: { state: string; asOf: string | null; ageSeconds: number | null };
        fallbackReason?: string;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(response.headers.get("Server-Timing")).toMatch(
      /(?:^|,\s*)omnigaze;dur=\d+\.\d$/,
    );
    expect(body.data).toMatchObject({
      symbolId: "NASDAQ:NVDA",
      isDelayed: true,
    });
    expect(Number.isNaN(Date.parse(body.data.asOf))).toBe(false);
    expect(body.data.provider).toBeTruthy();
    expect(body.meta).toMatchObject({
      dataMode: "demo",
      providerCoverage: "demo",
      freshness: {
        state: "fixture",
        asOf: body.data.asOf,
        ageSeconds: null,
      },
      fallbackReason: "provider_unconfigured",
    });
  });

  it("distinguishes malformed symbols from supported-but-unknown symbols", async () => {
    const malformed = await getSnapshot(
      new Request("https://omnigaze.test/api/market/snapshot?symbol=NVDA"),
    );
    const unknown = await getSnapshot(
      new Request("https://omnigaze.test/api/market/snapshot?symbol=NASDAQ:UNKNOWN"),
    );

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      code: "invalid_symbol",
      error: "A canonical symbol such as NASDAQ:NVDA is required.",
    });
    expect([422, 503]).toContain(unknown.status);
    expect(await unknown.json()).toMatchObject({
      code:
        unknown.status === 422
          ? "symbol_not_supported"
          : "asset_catalog_unavailable",
    });
  });

  it("never serves a known ticker under a forged exchange identity", async () => {
    const response = await getSnapshot(
      new Request("https://omnigaze.test/api/market/snapshot?symbol=NYSE:NVDA"),
    );
    const body = await response.json();

    expect([422, 503]).toContain(response.status);
    expect(body).toMatchObject({
      code:
        response.status === 422
          ? "symbol_not_supported"
          : "asset_catalog_unavailable",
    });
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain('"symbolId":"NYSE:NVDA"');
  });

  it("keeps intelligence responses bounded when query values are invalid", async () => {
    const response = await getIntelligence(
      new Request(
        "https://omnigaze.test/api/intelligence?minimum_materiality=unsupported&limit=not-a-number",
      ),
    );
    const body = (await response.json()) as {
      data: unknown[];
      meta: {
        dataMode: string;
        providerCoverage: string;
        freshness: { state: string };
        fallbackReason?: string;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(response.headers.get("Server-Timing")).toMatch(
      /(?:^|,\s*)omnigaze;dur=\d+\.\d$/,
    );
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(20);
    expect(body.meta).toMatchObject({
      dataMode: "demo",
      providerCoverage: "demo",
      freshness: { state: "fixture" },
      fallbackReason: "provider_unconfigured",
    });
  });

  it("returns a machine-readable health contract", async () => {
    const getHealth = createHealthHandler({
      getProviderStatus: async () => ({
        checkedAt: "2026-11-12T08:00:00.000Z",
        providers: [],
        liveCapabilities: [],
      }),
      checkDatabaseReadiness: async () => ({
        status: "ready",
        checkedAt: "2026-11-12T08:00:00.000Z",
        schema: "sec-fair-access-v1",
      }),
      getIngestionReadiness: async () => ({
        mode: "request_time",
        status: "idle",
        expectedCadenceSeconds: null,
        lastSuccessAt: null,
        latestEvidenceAt: null,
        generatedAt: "2026-11-12T08:00:00.000Z",
        since: "2026-11-11T08:00:00.000Z",
        providers: [],
      }),
    });
    const response = await getHealth();
    const body = (await response.json()) as {
      service: string;
      status: string;
      version: string;
      checkedAt: string;
      capabilities: string[];
      readiness: {
        database: { status: string; schema: string };
        ingestion: { mode: string; status: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      service: "omnigaze-web",
      status: "ok",
      version: "0.1.0",
    });
    expect(body.capabilities).toContain("mcp-2026-07-28");
    expect(body.capabilities).toContain("market-news-intelligence");
    expect(body.capabilities).not.toContain("sec-filing-intelligence");
    expect(body.capabilities).toContain("durable-intelligence-inbox");
    expect(body.capabilities).toContain("in-app-alert-rules");
    expect(body.capabilities).toContain("portfolio-pulse-v1");
    expect(body.readiness.database).toEqual({
      status: "ready",
      checkedAt: "2026-11-12T08:00:00.000Z",
      schema: "sec-fair-access-v1",
    });
    expect(body.readiness.ingestion).toMatchObject({
      mode: "request_time",
      status: "idle",
    });
    expect(body.capabilities).toContain("bounded-cursor-ingestion");
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  it("keeps liveness monitorable while reporting a missing database schema", async () => {
    const getHealth = createHealthHandler({
      getProviderStatus: async () => ({
        checkedAt: "2026-11-12T08:00:00.000Z",
        providers: [],
        liveCapabilities: [],
      }),
      checkDatabaseReadiness: async () => ({
        status: "unavailable",
        checkedAt: "2026-11-12T08:00:00.000Z",
        schema: "sec-fair-access-v1",
      }),
      getIngestionReadiness: async () => ({
        mode: "unavailable",
        status: "unavailable",
        expectedCadenceSeconds: null,
        lastSuccessAt: null,
        latestEvidenceAt: null,
        generatedAt: "2026-11-12T08:00:00.000Z",
        since: "2026-11-11T08:00:00.000Z",
        providers: [],
      }),
    });

    const response = await getHealth();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "degraded",
      readiness: {
        database: {
          status: "unavailable",
          schema: "sec-fair-access-v1",
        },
      },
    });
    expect(body).not.toHaveProperty("error");
    expect(JSON.stringify(body)).not.toMatch(/binding|sqlite|query|exception/i);
  });

});
