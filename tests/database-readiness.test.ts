import { describe, expect, it, vi } from "vitest";
import { checkDatabaseReadiness } from "@/lib/services/database-readiness";

const NOW = new Date("2026-11-12T08:00:00.000Z");

describe("database readiness", () => {
  it("reports ready only when inbox, ingestion, AI guardrail, SEC, and owner projection markers exist", async () => {
    const values = vi.fn(async () => [
      [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 12, 12, 1, 4, 7, 10],
    ]);

    await expect(
      checkDatabaseReadiness(() => ({ values }), () => NOW),
    ).resolves.toEqual({
      status: "ready",
      checkedAt: NOW.toISOString(),
      schema: "owner-projection-cursor-v1",
    });
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable for a partial migration without leaking details", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 0, 0, 0, 0],
        ],
      }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "owner-projection-cursor-v1",
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
      schema: "owner-projection-cursor-v1",
    });
  });

  it("rejects a Daily Brief cache table with unexpected extra columns", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 12, 13, 1, 4],
        ],
      }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "owner-projection-cursor-v1",
    });
  });

  it("rejects a cache-only partial 0006 without the widened budget constraint", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 12, 12, 0, 4],
        ],
      }),
      () => NOW,
    );

    expect(result.status).toBe("unavailable");
    expect(result.schema).toBe("owner-projection-cursor-v1");
  });

  it("rejects the complete pre-0007 schema without SEC admission control", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 12, 12, 1, 0],
        ],
      }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "owner-projection-cursor-v1",
    });
  });

  it("rejects a projection cursor table missing any runtime lease column", async () => {
    const result = await checkDatabaseReadiness(
      () => ({
        values: async () => [
          [3, 2, 2, 2, 3, 3, 4, 15, 12, 5, 2, 9, 10, 12, 12, 12, 1, 4, 7, 9],
        ],
      }),
      () => NOW,
    );

    expect(result).toEqual({
      status: "unavailable",
      checkedAt: NOW.toISOString(),
      schema: "owner-projection-cursor-v1",
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
