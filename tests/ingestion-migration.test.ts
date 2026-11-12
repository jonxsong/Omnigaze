import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  providerIngestionCheckpoints,
  providerIngestionRunErrors,
  providerIngestionRuns,
  sourceEventIngestionMetadata,
  sourceEventSymbols,
} from "@/db/schema";

type SnapshotTable = {
  columns: Record<string, unknown>;
  checkConstraints: Record<string, unknown>;
};

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
};

function readJson<T>(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as T;
}

describe("global ingestion control-plane migration", () => {
  it("chains and registers additive migration 0004", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0003_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0004_snapshot.json");
    const journal = readJson<{
      entries: Array<{
        idx: number;
        tag: string;
        version: string;
        when: number;
        breakpoints: boolean;
      }>;
    }>("drizzle/meta/_journal.json");

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.at(-1)).toEqual({
      idx: 4,
      tag: "0004_ingestion_control_plane_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["provider_ingestion_checkpoints", providerIngestionCheckpoints],
    ["provider_ingestion_runs", providerIngestionRuns],
    ["provider_ingestion_run_errors", providerIngestionRunErrors],
    ["source_event_symbols", sourceEventSymbols],
    ["source_event_ingestion_metadata", sourceEventIngestionMetadata],
  ] as const)("matches generated columns and checks for %s", (name, table) => {
    const snapshot = readJson<Snapshot>("drizzle/meta/0004_snapshot.json");
    const config = getTableConfig(table);

    expect(Object.keys(snapshot.tables[name].columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(snapshot.tables[name].checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("is create-only and contains no owner-scoped data or fixture backfill", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0004_ingestion_control_plane_v1.sql"),
      "utf8",
    );

    expect(migration.match(/CREATE TABLE/g)).toHaveLength(5);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER)\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toContain("owner_id");
    expect(migration).toContain("payload_policy = 'minimal_redacted_v1'");
  });
});
