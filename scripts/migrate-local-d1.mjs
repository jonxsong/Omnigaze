import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "drizzle");
const configPath = resolve(projectRoot, ".openai", "wrangler.local.jsonc");
const persistencePath = resolve(projectRoot, ".wrangler", "state");
const wranglerPath = resolve(
  projectRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const databaseName = "site-creator-d1";

const migrationTableSql = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function makeAdditiveStatementIdempotent(statement) {
  const trimmed = statement.trim();
  if (!trimmed) return null;

  if (/^CREATE\s+TABLE\s+/i.test(trimmed)) {
    return trimmed.replace(
      /^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\s+)/i,
      "CREATE TABLE IF NOT EXISTS ",
    );
  }
  if (/^CREATE\s+UNIQUE\s+INDEX\s+/i.test(trimmed)) {
    return trimmed.replace(
      /^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\s+)/i,
      "CREATE UNIQUE INDEX IF NOT EXISTS ",
    );
  }
  if (/^CREATE\s+INDEX\s+/i.test(trimmed)) {
    return trimmed.replace(
      /^CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\s+)/i,
      "CREATE INDEX IF NOT EXISTS ",
    );
  }

  throw new Error(
    "Local migration reconciliation only supports additive CREATE TABLE/INDEX statements.",
  );
}

export function makeMigrationIdempotent(sqlText) {
  return sqlText
    .split("--> statement-breakpoint")
    .map(makeAdditiveStatementIdempotent)
    .filter(Boolean)
    .map((statement) =>
      statement.endsWith(";") ? statement : `${statement};`,
    )
    .join("\n");
}

export async function buildPendingMigrationSql(
  appliedNames = new Set(),
  directory = migrationDirectory,
) {
  const migrationNames = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  const pendingNames = migrationNames.filter((name) => !appliedNames.has(name));
  const blocks = [migrationTableSql];

  for (const name of pendingNames) {
    const migration = await readFile(resolve(directory, name), "utf8");
    blocks.push(
      `-- ${name}`,
      makeMigrationIdempotent(migration),
      `INSERT OR IGNORE INTO d1_migrations (name) VALUES (${sqlString(name)});`,
    );
  }

  return {
    pendingNames,
    sql: `${blocks.join("\n")}\n`,
  };
}

function wranglerArguments(...operation) {
  return [
    wranglerPath,
    "d1",
    "execute",
    databaseName,
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persistencePath,
    ...operation,
  ];
}

function runWrangler(operation, { capture = false } = {}) {
  const environment = { ...process.env, CI: "1", NO_COLOR: "1" };
  delete environment.FORCE_COLOR;
  const result = spawnSync(process.execPath, wranglerArguments(...operation), {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : "See Wrangler output above.";
    throw new Error(`Local D1 migration command failed. ${detail}`);
  }
  return result.stdout ?? "";
}

function parseAppliedMigrationNames(output) {
  const payload = JSON.parse(output);
  const results = Array.isArray(payload) ? payload : [payload];
  return new Set(
    results.flatMap((entry) =>
      Array.isArray(entry?.results)
        ? entry.results
            .map((row) => row?.name)
            .filter((name) => typeof name === "string")
        : [],
    ),
  );
}

export async function migrateLocalD1() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omnigaze-d1-"));
  try {
    const bootstrapPath = resolve(temporaryDirectory, "bootstrap.sql");
    await writeFile(bootstrapPath, `${migrationTableSql}\n`, "utf8");
    runWrangler(["--file", bootstrapPath, "--yes"]);

    const appliedOutput = runWrangler(
      [
        "--command",
        "SELECT name FROM d1_migrations ORDER BY name;",
        "--json",
      ],
      { capture: true },
    );
    const appliedNames = parseAppliedMigrationNames(appliedOutput);
    const pending = await buildPendingMigrationSql(appliedNames);

    if (pending.pendingNames.length === 0) {
      console.log("Local D1 schema is current; no migrations to apply.");
      return;
    }

    const pendingPath = resolve(temporaryDirectory, "pending.sql");
    await writeFile(pendingPath, pending.sql, "utf8");
    runWrangler(["--file", pendingPath, "--yes"]);
    console.log(
      `Applied ${pending.pendingNames.length} local D1 migration(s): ${pending.pendingNames.join(", ")}`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await migrateLocalD1();
}
