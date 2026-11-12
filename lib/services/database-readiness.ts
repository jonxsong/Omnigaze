import { sql, type SQL } from "drizzle-orm";

export type DatabaseReadinessStatus = "ready" | "unavailable";

export interface DatabaseReadiness {
  status: DatabaseReadinessStatus;
  checkedAt: string;
  schema: "intelligence-inbox-v1";
}

export interface ReadinessDatabase {
  values(query: SQL): Promise<unknown[][]>;
}

export type ReadinessDatabaseFactory =
  () => ReadinessDatabase | Promise<ReadinessDatabase>;

const REQUIRED_COLUMN_COUNTS = [3, 2, 2, 2, 3, 3, 4] as const;

async function runtimeDatabaseFactory(): Promise<ReadinessDatabase> {
  const { getDb } = await import("@/db");
  return getDb() as ReadinessDatabase;
}

export async function checkDatabaseReadiness(
  databaseFactory: ReadinessDatabaseFactory = runtimeDatabaseFactory,
  now = () => new Date(),
): Promise<DatabaseReadiness> {
  const checkedAt = now().toISOString();

  try {
    const database = await databaseFactory();
    const rows = (await database.values(sql`
      SELECT
        (SELECT COUNT(*) FROM pragma_table_info('inbox_events')
          WHERE name IN ('id', 'provider_revision_at', 'revision')),
        (SELECT COUNT(*) FROM pragma_table_info('inbox_event_symbols')
          WHERE name IN ('event_id', 'symbol_id')),
        (SELECT COUNT(*) FROM pragma_table_info('inbox_profiles')
          WHERE name IN ('owner_id', 'baseline_completed_at')),
        (SELECT COUNT(*) FROM pragma_table_info('inbox_event_states')
          WHERE name IN ('owner_id', 'event_id')),
        (SELECT COUNT(*) FROM pragma_table_info('alert_rules')
          WHERE name IN ('owner_id', 'symbol_id', 'enabled')),
        (SELECT COUNT(*) FROM pragma_table_info('alert_deliveries')
          WHERE name IN ('owner_id', 'event_id', 'event_revision')),
        (SELECT COUNT(*) FROM pragma_table_info('inbox_sync_gates')
          WHERE name IN ('owner_id', 'claim_until', 'next_allowed_at', 'catchup_pending'))
    `)) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ][];
    const row = rows[0];
    const ready =
      row?.length === REQUIRED_COLUMN_COUNTS.length &&
      row.every((count, index) => count === REQUIRED_COLUMN_COUNTS[index]);

    return {
      status: ready ? "ready" : "unavailable",
      checkedAt,
      schema: "intelligence-inbox-v1",
    };
  } catch {
    return {
      status: "unavailable",
      checkedAt,
      schema: "intelligence-inbox-v1",
    };
  }
}
