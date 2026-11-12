import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  inboxProjectionChanges,
  inboxProjectionCursors,
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

describe("owner intelligence projection migration", () => {
  it("chains and registers additive migration 0008", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0007_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0008_snapshot.json");
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
    expect(journal.entries.find((entry) => entry.idx === 8)).toEqual({
      idx: 8,
      tag: "0008_inbox_projection_cursor_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["inbox_projection_changes", inboxProjectionChanges],
    ["inbox_projection_cursors", inboxProjectionCursors],
  ] as const)("matches generated columns and checks for %s", (name, table) => {
    const snapshot = readJson<Snapshot>("drizzle/meta/0008_snapshot.json");
    const config = getTableConfig(table);

    expect(Object.keys(snapshot.tables[name].columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(snapshot.tables[name].checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("is create-only and contains monotonic and owner-isolation constraints", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0008_inbox_projection_cursor_v1.sql"),
      "utf8",
    );

    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER)\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).toContain("integer PRIMARY KEY AUTOINCREMENT NOT NULL");
    expect(migration).toContain("`logical_event_id` text NOT NULL");
    expect(migration).toContain(
      "UNIQUE INDEX `inbox_projection_changes_run_receipt_idx`",
    );
    expect(migration).toContain(
      "INDEX `inbox_projection_changes_logical_sequence_idx`",
    );
    expect(migration).toContain("`owner_id` text PRIMARY KEY NOT NULL");
    expect(migration).toContain("last_sequence >= 0");
  });
});
