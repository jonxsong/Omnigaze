export const ACCOUNT_DATA_EXPORT_FORMAT = "json" as const;
export const ACCOUNT_DATA_EXPORT_SCHEMA_VERSION =
  "omnigaze.saved-data-snapshot.v1" as const;

export type AccountDataExportRequest = {
  format: typeof ACCOUNT_DATA_EXPORT_FORMAT;
};

type AccountDataExportRequestResult =
  | { success: true; data: AccountDataExportRequest }
  | { success: false };

/**
 * The export endpoint deliberately has a tiny, dependency-free wire contract.
 * Unknown keys fail closed so a client cannot accidentally request a broader
 * data scope than the server knows how to produce.
 */
export function parseAccountDataExportRequest(
  value: unknown,
): AccountDataExportRequestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "format") {
    return { success: false };
  }
  if ((value as Record<string, unknown>).format !== ACCOUNT_DATA_EXPORT_FORMAT) {
    return { success: false };
  }
  return { success: true, data: { format: ACCOUNT_DATA_EXPORT_FORMAT } };
}

export function accountDataExportFilename(exportedAt: string) {
  const parsed = new Date(exportedAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid export timestamp.");
  }
  return `omnigaze-saved-data-snapshot-${parsed.toISOString().slice(0, 10)}.json`;
}
