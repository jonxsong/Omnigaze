import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  alertDeliveries,
  alertRules,
  inboxEventStates,
  inboxEventSymbols,
  inboxEvents,
  inboxProfiles,
  inboxSyncGates,
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

describe("intelligence inbox migration artifacts", () => {
  it("chains the generated snapshot and registers additive migration 0003", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0002_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0003_snapshot.json");
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
      idx: 3,
      tag: "0003_intelligence_inbox_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["inbox_events", inboxEvents],
    ["inbox_event_symbols", inboxEventSymbols],
    ["inbox_profiles", inboxProfiles],
    ["inbox_sync_gates", inboxSyncGates],
    ["inbox_event_states", inboxEventStates],
    ["alert_rules", alertRules],
    ["alert_deliveries", alertDeliveries],
  ] as const)("matches generated columns and checks for %s", (name, table) => {
    const snapshot = readJson<Snapshot>("drizzle/meta/0003_snapshot.json");
    const config = getTableConfig(table);

    expect(Object.keys(snapshot.tables[name].columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(snapshot.tables[name].checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("contains only additive DDL and no fixture backfill", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0003_intelligence_inbox_v1.sql"),
      "utf8",
    );

    expect(migration.match(/CREATE TABLE/g)).toHaveLength(7);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER)\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).toContain(
      "PRIMARY KEY(`owner_id`, `rule_symbol_id`, `event_id`, `event_revision`)",
    );
  });
});
