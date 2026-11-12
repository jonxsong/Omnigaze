import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness } from "@/lib/services/database-readiness";

const NOW = new Date("2026-11-12T08:00:00.000Z");

describe("database readiness", () => {
  it("reports ready only when inbox, ingestion, and AI guardrail schema markers exist", async () => {
    const values = vi.fn(async () => [
      [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12],
    ]);

    await expect(
      checkDatabaseReadiness(() => ({ values }), () => NOW),
    ).resolves.toEqual({
      status: "ready",
      checkedAt: NOW.toISOString(),
      schema: "ai-guardrails-v1",
    });
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable for a partial migration without leaking details", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 0],
        ],
      }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "ai-guardrails-v1",
    });
    expect(JSON.stringify(result)).not.toMatch(/table|column|sqlite|query/i);
  });

  it("does not report ready on the pre-0004 inbox-only schema", async () => {
    const result = await checkDatabaseReadiness(
      () => ({ values: async () => [[3, 2, 2, 2, 3, 3, 4]] }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "ai-guardrails-v1",
    });
  });

  it("collapses database failures into a sanitized unavailable result", async () => {
    const result = await checkDatabaseReadiness(
      () => {
        throw new Error("private binding and filesystem details");
      },
      () => NOW,
    );

    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private binding");
  });
});
