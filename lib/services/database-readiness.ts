import { sql, type SQL } from "drizzle-orm";

export type DatabaseReadinessStatus = "ready" | "unavailable";

export interface DatabaseReadiness {
  status: DatabaseReadinessStatus;
  checkedAt: string;
  schema: "ai-guardrails-v1";
}

export interface ReadinessDatabase {
  values(query: SQL): Promise<unknown[][]>;
}

export type ReadinessDatabaseFactory =
  () => ReadinessDatabase | Promise<ReadinessDatabase>;

const REQUIRED_COLUMN_COUNTS = [
  3, 2, 2, 2, 3, 3, 4,
  15, 12, 5, 2, 9, 10, 12,
] as const;

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
          WHERE name IN ('owner_id', 'claim_until', 'next_allowed_at', 'catchup_pending')),
        (SELECT COUNT(*) FROM pragma_table_info('provider_ingestion_checkpoints')
          WHERE name IN (
            'provider', 'partition_key', 'lease_token', 'lease_expires_at',
            'window_start', 'window_end', 'window_fingerprint', 'resume_cursor',
            'high_water_mark', 'next_due_at', 'last_success_at', 'last_failure_at',
            'consecutive_failures', 'total_successes', 'total_failures'
          )),
        (SELECT COUNT(*) FROM pragma_table_info('provider_ingestion_runs')
          WHERE name IN (
            'id', 'provider', 'partition_key', 'lease_token', 'window_fingerprint',
            'resume_cursor_start', 'resume_cursor_end', 'page_fingerprint',
            'page_persisted_at', 'status', 'started_at', 'completed_at'
          )),
        (SELECT COUNT(*) FROM pragma_table_info('provider_ingestion_run_errors')
          WHERE name IN ('id', 'run_id', 'code', 'safe_message', 'occurred_at')),
        (SELECT COUNT(*) FROM pragma_table_info('source_event_symbols')
          WHERE name IN ('source_event_id', 'symbol_id')),
        (SELECT COUNT(*) FROM pragma_table_info('source_event_ingestion_metadata')
          WHERE name IN (
            'source_event_id', 'provider', 'partition_key', 'payload_policy',
            'provider_revision_at', 'first_ingestion_run_id',
            'last_ingestion_run_id', 'last_seen_at', 'seen_count'
          )),
        (SELECT COUNT(*) FROM pragma_table_info('ai_view_cache_entries')
          WHERE name IN (
            'cache_key', 'symbol_id', 'prompt_version', 'model_key',
            'evidence_fingerprint', 'response_json', 'generated_at',
            'expires_at', 'last_accessed_at', 'hit_count'
          )),
        (SELECT COUNT(*) FROM pragma_table_info('ai_model_budget_reservations')
          WHERE name IN (
            'reservation_id', 'owner_id', 'request_key_hash', 'operation',
            'operation_key_hash', 'cost', 'day_start', 'status', 'reserved_at',
            'lease_expires_at', 'completed_at', 'safe_error_code'
          ))
    `)) as number[][];
    const row = rows[0];
    const ready =
      row?.length === REQUIRED_COLUMN_COUNTS.length &&
      row.every((count, index) => count === REQUIRED_COLUMN_COUNTS[index]);

    return {
      status: ready ? "ready" : "unavailable",
      checkedAt,
      schema: "ai-guardrails-v1",
    };
  } catch {
    return {
      status: "unavailable",
      checkedAt,
      schema: "ai-guardrails-v1",
    };
  }
}
