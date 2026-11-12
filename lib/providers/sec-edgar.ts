import type { CanonicalSymbol } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import {
  ProviderCursorMismatchError,
  ProviderCursorRejectedError,
  type IntelligenceEventPage,
  type IntelligenceEventPageRequest,
  type IntelligenceSourceResult,
  type PaginatedIntelligenceSourceProvider,
} from "./contracts";
import type { SecFairAccessCoordinator } from "./sec-fair-access";

type SecEdgarConfig = {
  enabled?: boolean;
  userAgent?: string;
  coordinator?: SecFairAccessCoordinator;
  cikByTicker?: Record<string, string>;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_LIMIT_WINDOW_MS = 1_000;
const TICKER_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;
const SUBMISSIONS_CACHE_TTL_MS = 60 * 1_000;
const MAX_SUBMISSIONS_CACHE_ENTRIES = 32;
const MAX_CATALOG_ENTRIES = 25_000;
const MAX_FILINGS_PER_CIK = 2_000;
const MAX_REQUEST_SYMBOLS = 100;
const MAX_RESULT_LIMIT = 100;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_CURSOR_LENGTH = 1_024;
const SEC_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TICKER_CATALOG_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SUBMISSIONS_RESPONSE_BYTES = 8 * 1024 * 1024;
const MIN_POLICY_COOLDOWN_SECONDS = 10 * 60;
const MAX_POLICY_COOLDOWN_SECONDS = 24 * 60 * 60;
// SEC timestamps should not lead the Worker clock beyond ordinary edge-clock drift.
const MAX_ACCEPTANCE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const TICKER_CATALOG_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_DORMANT_MESSAGE =
  "SEC requests are disabled until explicit production activation.";
const SEC_COORDINATOR_REQUIRED_MESSAGE =
  "SEC requests require the distributed Fair Access coordinator.";
const SEC_COORDINATOR_UNAVAILABLE_MESSAGE =
  "SEC Fair Access coordinator is unavailable.";
const SEC_COOLDOWN_MESSAGE = "SEC Fair Access cooldown is active.";
const canonicalSymbolPattern = /^[A-Z0-9._-]{1,32}:[A-Z0-9._-]{1,32}$/;
const tickerPattern = /^[A-Z0-9._-]{1,32}$/;
const cikPattern = /^[1-9]\d{0,9}$/;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const acceptanceTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const primaryDocumentPattern = /^[A-Za-z0-9._-]{1,256}$/;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function policyCooldownSeconds(response: Response, now: number) {
  const raw = response.headers.get("retry-after")?.trim() ?? "";
  let requested = Number.NaN;
  if (/^\d+$/.test(raw)) {
    requested = Number(raw);
  } else if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt) && Number.isFinite(now)) {
      requested = Math.ceil((retryAt - now) / 1_000);
    }
  }
  const bounded = Number.isFinite(requested)
    ? Math.min(
        Math.max(Math.ceil(requested), 0),
        MAX_POLICY_COOLDOWN_SECONDS,
      )
    : MIN_POLICY_COOLDOWN_SECONDS;
  return Math.max(MIN_POLICY_COOLDOWN_SECONDS, bounded);
}

type TickerCatalog = {
  exact: Map<string, string>;
  aliases: Map<string, string>;
};

type SecFiling = {
  accessionNumber: string;
  filingDate: string;
  acceptedAt: string;
  form: string;
  primaryDocument: string | null;
  cik: string;
};

type SecPageCursor = {
  version: 1;
  cik: string;
  snapshotDigest: string;
  acceptedAt: string;
  accessionNumber: string;
};

type SubmissionsCacheEntry = {
  fetchedAt: number;
  filings: SecFiling[];
};

function invalid(message = "SEC provider request is invalid."): never {
  throw new Error(message);
}

function normalizedUserAgent(value: string | undefined) {
  const candidate = value?.trim() ?? "";
  if (
    candidate.length < 8 ||
    candidate.length > 256 ||
    /[\u0000-\u001F\u007F]/.test(candidate) ||
    !/^\S(?:.*\S)?\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

export function isValidSecUserAgent(value: string | undefined) {
  return normalizedUserAgent(value) !== null;
}

function normalizedPageTimestamp(value: string, field: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    invalid(`SEC filing page ${field} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    invalid(`SEC filing page ${field} is invalid.`);
  }
  return new Date(timestamp).toISOString();
}

function normalizePageQuery(options: {
  symbols: CanonicalSymbol[];
  windowStart: string;
  windowEnd: string;
  pageSize: number;
}) {
  if (
    !Array.isArray(options.symbols) ||
    options.symbols.length === 0 ||
    options.symbols.length > MAX_REQUEST_SYMBOLS ||
    options.symbols.some((symbol) => typeof symbol !== "string") ||
    !Number.isSafeInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_PAGE_SIZE
  ) {
    invalid("SEC filing page request is invalid.");
  }
  const symbols = [
    ...new Set(options.symbols.map((symbol) => symbol.trim().toUpperCase())),
  ].sort() as CanonicalSymbol[];
  if (
    symbols.length === 0 ||
    symbols.some((symbol) => !canonicalSymbolPattern.test(symbol))
  ) {
    invalid("SEC filing page request is invalid.");
  }
  const windowStart = normalizedPageTimestamp(
    options.windowStart,
    "window start",
  );
  const windowEnd = normalizedPageTimestamp(options.windowEnd, "window end");
  if (windowStart >= windowEnd) {
    invalid("SEC filing page window start must precede window end.");
  }
  return { symbols, windowStart, windowEnd, pageSize: options.pageSize };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSecFilingQueryFingerprint(options: {
  cik: string;
  symbols: CanonicalSymbol[];
  windowStart: string;
  windowEnd: string;
  pageSize: number;
}) {
  const query = normalizePageQuery(options);
  const cik = normalizedCik(options.cik);
  if (!cik) invalid("SEC filing page CIK is invalid.");
  return sha256Hex(
    JSON.stringify({
      provider: "sec-edgar",
      stream: "submissions-recent",
      version: 1,
      cik,
      symbols: query.symbols,
      windowStart: query.windowStart,
      windowEnd: query.windowEnd,
      pageSize: query.pageSize,
      sort: "accepted_at_asc_accession_asc",
    }),
  );
}

function normalizedCik(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const candidate = String(value).trim().replace(/^0+/, "");
  return cikPattern.test(candidate) ? candidate : null;
}

function tickerAlias(value: string) {
  return value.replaceAll(".", "-");
}

function createTickerCatalog(
  entries: Iterable<readonly [string, string]>,
  strict: boolean,
) {
  const exact = new Map<string, string>();
  const ambiguousExact = new Set<string>();
  const aliasCandidates = new Map<string, Set<string>>();
  let count = 0;

  for (const [rawTicker, rawCik] of entries) {
    count += 1;
    if (count > MAX_CATALOG_ENTRIES) {
      invalid("SEC ticker catalog exceeded its bounded size.");
    }
    const ticker = rawTicker.trim().toUpperCase();
    const cik = normalizedCik(rawCik);
    if (!tickerPattern.test(ticker) || !cik) {
      if (strict) invalid("SEC CIK configuration is invalid.");
      continue;
    }
    const alias = tickerAlias(ticker);
    const candidates = aliasCandidates.get(alias) ?? new Set<string>();
    candidates.add(cik);
    aliasCandidates.set(alias, candidates);
    if (ambiguousExact.has(ticker)) continue;
    const current = exact.get(ticker);
    if (current && current !== cik) {
      if (strict) invalid("SEC CIK configuration is ambiguous.");
      exact.delete(ticker);
      ambiguousExact.add(ticker);
      continue;
    }
    exact.set(ticker, cik);
  }

  const aliases = new Map<string, string>();
  for (const [alias, candidates] of aliasCandidates) {
    const [candidate] = candidates;
    if (candidates.size === 1 && candidate) aliases.set(alias, candidate);
  }
  return { exact, aliases } satisfies TickerCatalog;
}

function resolveCatalogExact(catalog: TickerCatalog, ticker: string) {
  return catalog.exact.get(ticker) ?? null;
}

function resolveCatalogAlias(catalog: TickerCatalog, ticker: string) {
  return catalog.aliases.get(tickerAlias(ticker)) ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function validUtcDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function strictAcceptanceTimestamp(value: string) {
  if (!acceptanceTimePattern.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const expected = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  return new Date(timestamp).toISOString() === expected ? timestamp : null;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  errorMessage: string,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) invalid(errorMessage);
    const advertisedBytes = Number(contentLength);
    if (!Number.isSafeInteger(advertisedBytes) || advertisedBytes > maxBytes) {
      invalid(errorMessage);
    }
  }
  if (!response.body) invalid(errorMessage);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        invalid(errorMessage);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    invalid(errorMessage);
  } finally {
    reader.releaseLock();
  }
}

function parseSubmissions(value: unknown, cik: string, now: number): SecFiling[] {
  const root = record(value);
  const filings = root ? record(root.filings) : null;
  const recent = filings ? record(filings.recent) : null;
  if (!root || !filings || !recent) {
    invalid("SEC submissions returned an invalid response.");
  }

  const accessionNumbers = stringArray(recent.accessionNumber);
  const filingDates = stringArray(recent.filingDate);
  const acceptanceTimes = stringArray(recent.acceptanceDateTime);
  const forms = stringArray(recent.form);
  const primaryDocuments = stringArray(recent.primaryDocument);
  if (
    !accessionNumbers ||
    !filingDates ||
    !acceptanceTimes ||
    !forms ||
    !primaryDocuments ||
    accessionNumbers.length > MAX_FILINGS_PER_CIK ||
    [filingDates, acceptanceTimes, forms, primaryDocuments].some(
      (items) => items.length !== accessionNumbers.length,
    )
  ) {
    invalid("SEC submissions returned an invalid response.");
  }

  return accessionNumbers.map((accessionNumber, index) => {
    const filingDate = filingDates[index];
    const acceptanceTime = acceptanceTimes[index];
    const form = forms[index].trim();
    const primaryDocument = primaryDocuments[index].trim();
    const acceptanceTimestamp = acceptanceTime
      ? strictAcceptanceTimestamp(acceptanceTime)
      : null;
    if (
      !accessionPattern.test(accessionNumber) ||
      !validUtcDate(filingDate) ||
      acceptanceTime.length > 64 ||
      (acceptanceTime.length > 0 && acceptanceTimestamp === null) ||
      !form ||
      form.length > 64 ||
      (primaryDocument && !primaryDocumentPattern.test(primaryDocument))
    ) {
      invalid("SEC submissions returned an invalid response.");
    }
    const acceptedAtTimestamp =
      acceptanceTimestamp ?? Date.parse(`${filingDate}T00:00:00.000Z`);
    if (
      !Number.isFinite(now) ||
      acceptedAtTimestamp > now + MAX_ACCEPTANCE_CLOCK_SKEW_MS
    ) {
      invalid("SEC submissions returned an invalid response.");
    }
    const acceptedAt = new Date(acceptedAtTimestamp).toISOString();
    return {
      accessionNumber,
      filingDate,
      acceptedAt,
      form,
      primaryDocument: primaryDocument || null,
      cik,
    };
  });
}

function filingSort(left: SecFiling, right: SecFiling) {
  return (
    left.acceptedAt.localeCompare(right.acceptedAt) ||
    left.accessionNumber.localeCompare(right.accessionNumber)
  );
}

function canonicalFilingSnapshot(filings: SecFiling[]) {
  const byAccession = new Map<string, SecFiling>();
  for (const filing of filings) {
    const existing = byAccession.get(filing.accessionNumber);
    if (existing && JSON.stringify(existing) !== JSON.stringify(filing)) {
      invalid("SEC submissions returned an ambiguous filing snapshot.");
    }
    byAccession.set(filing.accessionNumber, filing);
  }
  return [...byAccession.values()].sort(filingSort);
}

async function filingSnapshotDigest(filings: SecFiling[]) {
  return sha256Hex(
    JSON.stringify(
      filings.map((filing) => ({
        cik: filing.cik,
        accessionNumber: filing.accessionNumber,
        filingDate: filing.filingDate,
        acceptedAt: filing.acceptedAt,
        form: filing.form,
        primaryDocument: filing.primaryDocument,
      })),
    ),
  );
}

function encodePageCursor(cursor: SecPageCursor) {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodePageCursor(token: string): SecPageCursor {
  const candidate = token.trim();
  if (
    candidate.length === 0 ||
    candidate.length > MAX_PAGE_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(candidate)
  ) {
    throw new ProviderCursorRejectedError("sec-edgar");
  }
  try {
    const padding = "=".repeat((4 - (candidate.length % 4)) % 4);
    const decoded = JSON.parse(
      atob(candidate.replaceAll("-", "+").replaceAll("_", "/") + padding),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid");
    }
    const value = decoded as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        "acceptedAt,accessionNumber,cik,snapshotDigest,version" ||
      value.version !== 1 ||
      typeof value.cik !== "string" ||
      !cikPattern.test(value.cik) ||
      typeof value.snapshotDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.snapshotDigest) ||
      typeof value.acceptedAt !== "string" ||
      strictAcceptanceTimestamp(value.acceptedAt) === null ||
      new Date(Date.parse(value.acceptedAt)).toISOString() !== value.acceptedAt ||
      typeof value.accessionNumber !== "string" ||
      !accessionPattern.test(value.accessionNumber)
    ) {
      throw new Error("invalid");
    }
    const cursor = value as SecPageCursor;
    if (encodePageCursor(cursor) !== candidate) throw new Error("invalid");
    return cursor;
  } catch (error) {
    if (error instanceof ProviderCursorRejectedError) throw error;
    throw new ProviderCursorRejectedError("sec-edgar");
  }
}

function filingSourceUrl(filing: SecFiling) {
  return filing.primaryDocument
    ? `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accessionNumber.replaceAll("-", "")}/${filing.primaryDocument}`
    : null;
}

function filingEvent(
  filing: SecFiling,
  symbols: CanonicalSymbol[],
  receivedAt: string,
): RawSourceEvent {
  const headline = `${filing.form} filed with the SEC`;
  return {
    source: "sec-edgar",
    sourceKind: "sec_filing",
    sourceEventId: filing.accessionNumber,
    receivedAt,
    publishedAt: filing.acceptedAt,
    providerUpdatedAt: filing.acceptedAt,
    payload: {
      ...filing,
      symbols,
      headline,
      summary: "A new regulatory filing is available for evidence review.",
      url: filingSourceUrl(filing),
    },
  };
}

function normalizeRequest(options: {
  symbols: CanonicalSymbol[];
  since: string;
  limit: number;
}) {
  if (
    !Array.isArray(options.symbols) ||
    options.symbols.length > MAX_REQUEST_SYMBOLS ||
    options.symbols.some((symbol) => typeof symbol !== "string") ||
    typeof options.since !== "string" ||
    options.since.length > 64
  ) {
    invalid();
  }
  const symbols = [
    ...new Set(options.symbols.map((symbol) => symbol.trim().toUpperCase())),
  ];
  if (
    symbols.some((symbol) => !canonicalSymbolPattern.test(symbol)) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_RESULT_LIMIT
  ) {
    invalid();
  }
  const sinceTime = Date.parse(options.since);
  if (!Number.isFinite(sinceTime)) invalid();
  return {
    symbols: symbols as CanonicalSymbol[],
    sinceTime,
    limit: options.limit,
  };
}

export class SecEdgarProvider implements PaginatedIntelligenceSourceProvider {
  readonly name = "sec-edgar";
  private tickerCatalog: { fetchedAt: number; value: TickerCatalog } | null = null;
  private tickerCatalogRequest: Promise<{
    value: TickerCatalog;
    degraded: boolean;
  }> | null = null;
  private readonly submissionsCache = new Map<string, SubmissionsCacheEntry>();
  private readonly submissionsRequests = new Map<string, Promise<SecFiling[]>>();
  private readonly requestStarts: number[] = [];
  private requestGate: Promise<void> = Promise.resolve();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly enabled: boolean;
  private readonly userAgent: string | null;
  private readonly coordinator: SecFairAccessCoordinator | null;
  private readonly configuredCatalog: TickerCatalog;

  constructor(config: SecEdgarConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? wait;
    this.enabled = config.enabled === true;
    this.userAgent = normalizedUserAgent(config.userAgent);
    this.coordinator = config.coordinator ?? null;
    this.configuredCatalog = createTickerCatalog(
      Object.entries(config.cikByTicker ?? {}),
      true,
    );
  }

  private headers() {
    if (!this.enabled) {
      throw new Error(SEC_DORMANT_MESSAGE);
    }
    if (!this.userAgent) {
      throw new Error("SEC_USER_AGENT must identify the Omnigaze application and operator.");
    }
    if (!this.coordinator) {
      throw new Error(SEC_COORDINATOR_REQUIRED_MESSAGE);
    }
    return { "User-Agent": this.userAgent, Accept: "application/json" };
  }

  private async acquireRequestSlot() {
    let release!: () => void;
    const previous = this.requestGate;
    this.requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      while (true) {
        const now = this.now();
        while (
          this.requestStarts.length > 0 &&
          this.requestStarts[0] <= now - RATE_LIMIT_WINDOW_MS
        ) {
          this.requestStarts.shift();
        }
        if (this.requestStarts.length < MAX_REQUESTS_PER_WINDOW) {
          this.requestStarts.push(now);
          return;
        }
        await this.sleep(
          Math.max(
            1,
            this.requestStarts[0] + RATE_LIMIT_WINDOW_MS - now,
          ),
        );
      }
    } finally {
      release();
    }
  }

  private async request(url: string, callerSignal?: AbortSignal) {
    const headers = this.headers();
    callerSignal?.throwIfAborted();
    await this.acquireRequestSlot();
    callerSignal?.throwIfAborted();
    await this.coordinator!.acquire();
    callerSignal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(SEC_REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetcher(url, {
      headers,
      signal,
    });
    if (response.status === 403 || response.status === 429) {
      await this.coordinator!.imposeCooldown(
        policyCooldownSeconds(response, this.now()),
      );
    }
    return response;
  }

  private async loadTickerCatalog() {
    const cached = this.tickerCatalog;
    if (cached && this.now() - cached.fetchedAt <= TICKER_CATALOG_TTL_MS) {
      return { value: cached.value, degraded: false };
    }
    if (this.tickerCatalogRequest) return this.tickerCatalogRequest;

    const request = (async () => {
      try {
        const response = await this.request(TICKER_CATALOG_URL);
        if (!response.ok) {
          throw new Error(`SEC ticker catalog failed with ${response.status}`);
        }
        const payload = await readBoundedJson(
          response,
          MAX_TICKER_CATALOG_RESPONSE_BYTES,
          "SEC ticker catalog exceeded its bounded response size.",
        );
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("SEC ticker catalog returned an invalid response");
        }

        const catalogPayload = payload as Record<string, unknown>;
        const rawKeys = Object.keys(catalogPayload);
        if (rawKeys.length > MAX_CATALOG_ENTRIES) {
          invalid("SEC ticker catalog exceeded its bounded size.");
        }
        const entries: Array<readonly [string, string]> = [];
        for (const key of rawKeys) {
          const value = catalogPayload[key];
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const record = value as Record<string, unknown>;
          if (
            typeof record.ticker !== "string" ||
            (typeof record.cik_str !== "number" &&
              typeof record.cik_str !== "string")
          ) {
            continue;
          }
          entries.push([record.ticker, String(record.cik_str)] as const);
        }
        const catalog = createTickerCatalog(entries, false);
        if (catalog.exact.size === 0) {
          throw new Error("SEC ticker catalog returned an invalid response");
        }
        this.tickerCatalog = { fetchedAt: this.now(), value: catalog };
        return { value: catalog, degraded: false };
      } catch (error) {
        if (cached) return { value: cached.value, degraded: true };
        throw error;
      }
    })();
    this.tickerCatalogRequest = request;

    try {
      return await request;
    } finally {
      if (this.tickerCatalogRequest === request) this.tickerCatalogRequest = null;
    }
  }

  private pruneSubmissionsCache() {
    while (this.submissionsCache.size > MAX_SUBMISSIONS_CACHE_ENTRIES) {
      let oldest: { cik: string; fetchedAt: number } | null = null;
      for (const [cik, entry] of this.submissionsCache) {
        if (!oldest || entry.fetchedAt < oldest.fetchedAt) {
          oldest = { cik, fetchedAt: entry.fetchedAt };
        }
      }
      if (!oldest) return;
      this.submissionsCache.delete(oldest.cik);
    }
  }

  private async fetchSubmissions(cik: string, signal?: AbortSignal) {
    const paddedCik = cik.padStart(10, "0");
    const response = await this.request(
      `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
      signal,
    );
    if (!response.ok) {
      throw new Error(`SEC submissions failed with ${response.status}`);
    }
    const payload = await readBoundedJson(
      response,
      MAX_SUBMISSIONS_RESPONSE_BYTES,
      "SEC submissions exceeded its bounded response size.",
    );
    return parseSubmissions(payload, cik, this.now());
  }

  private async loadSubmissions(cik: string) {
    const cached = this.submissionsCache.get(cik);
    if (cached && this.now() - cached.fetchedAt <= SUBMISSIONS_CACHE_TTL_MS) {
      return cached.filings;
    }
    const inFlight = this.submissionsRequests.get(cik);
    if (inFlight) return inFlight;

    const request = (async () => {
      const filings = await this.fetchSubmissions(cik);
      this.submissionsCache.set(cik, { fetchedAt: this.now(), filings });
      this.pruneSubmissionsCache();
      return filings;
    })();
    this.submissionsRequests.set(cik, request);
    try {
      return await request;
    } finally {
      if (this.submissionsRequests.get(cik) === request) {
        this.submissionsRequests.delete(cik);
      }
    }
  }

  private configuredPagePlan(symbols: CanonicalSymbol[]) {
    const ciks = new Set<string>();
    for (const symbol of symbols) {
      const ticker = symbol.split(":")[1];
      const cik =
        resolveCatalogExact(this.configuredCatalog, ticker) ??
        resolveCatalogAlias(this.configuredCatalog, ticker);
      if (!cik) {
        invalid(
          "SEC filing pages require an explicit CIK mapping for every symbol.",
        );
      }
      ciks.add(cik);
    }
    if (ciks.size !== 1) {
      invalid("SEC filing pages require exactly one configured CIK.");
    }
    const [cik] = ciks;
    if (!cik) invalid("SEC filing pages require exactly one configured CIK.");
    return {
      cik,
      symbols: [...symbols].sort() as CanonicalSymbol[],
    };
  }

  async getEventPage(
    options: IntelligenceEventPageRequest,
  ): Promise<IntelligenceEventPage> {
    const query = normalizePageQuery(options);
    const plan = this.configuredPagePlan(query.symbols);
    const queryFingerprint = await createSecFilingQueryFingerprint({
      ...query,
      cik: plan.cik,
    });
    const suppliedCursor = options.cursor ?? null;
    if (
      suppliedCursor &&
      suppliedCursor.queryFingerprint !== queryFingerprint
    ) {
      throw new ProviderCursorMismatchError(this.name);
    }
    const cursor = suppliedCursor
      ? decodePageCursor(suppliedCursor.token)
      : null;
    if (cursor && cursor.cik !== plan.cik) {
      throw new ProviderCursorRejectedError(this.name);
    }

    // Validate the explicit activation, operator identity, and coordinator
    // before the first possible SEC request. request() repeats the check at
    // the actual egress boundary.
    this.headers();
    const filings = canonicalFilingSnapshot(
      (await this.fetchSubmissions(plan.cik, options.signal)).filter(
        (filing) =>
          filing.acceptedAt >= query.windowStart &&
          filing.acceptedAt <= query.windowEnd,
      ),
    );
    const snapshotDigest = await filingSnapshotDigest(filings);
    let startIndex = 0;
    if (cursor) {
      if (
        cursor.snapshotDigest !== snapshotDigest ||
        cursor.acceptedAt < query.windowStart ||
        cursor.acceptedAt > query.windowEnd
      ) {
        throw new ProviderCursorRejectedError(this.name);
      }
      const cursorIndex = filings.findIndex(
        (filing) =>
          filing.acceptedAt === cursor.acceptedAt &&
          filing.accessionNumber === cursor.accessionNumber,
      );
      if (cursorIndex < 0) {
        throw new ProviderCursorRejectedError(this.name);
      }
      startIndex = cursorIndex + 1;
    }

    const selected = filings.slice(startIndex, startIndex + query.pageSize);
    const hasMore = startIndex + selected.length < filings.length;
    const last = selected.at(-1);
    if (hasMore && !last) {
      throw new ProviderCursorRejectedError(this.name);
    }
    const receivedAt = new Date(this.now()).toISOString();
    return {
      events: selected.map((filing) =>
        filingEvent(filing, plan.symbols, receivedAt),
      ),
      nextCursor:
        hasMore && last
          ? {
              token: encodePageCursor({
                version: 1,
                cik: plan.cik,
                snapshotDigest,
                acceptedAt: last.acceptedAt,
                accessionNumber: last.accessionNumber,
              }),
              queryFingerprint,
            }
          : null,
      exhausted: !hasMore,
      queryFingerprint,
    };
  }

  async getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<IntelligenceSourceResult> {
    this.headers();
    const request = normalizeRequest(options);
    if (request.symbols.length === 0) return [];

    const plan = new Map<string, Set<CanonicalSymbol>>();
    const unresolved: Array<{
      symbol: CanonicalSymbol;
      ticker: string;
      configuredAlias: string | null;
    }> = [];
    for (const symbol of request.symbols) {
      const ticker = symbol.split(":")[1];
      const configuredExact = resolveCatalogExact(this.configuredCatalog, ticker);
      if (configuredExact) {
        const symbols = plan.get(configuredExact) ?? new Set<CanonicalSymbol>();
        symbols.add(symbol);
        plan.set(configuredExact, symbols);
      } else {
        unresolved.push({
          symbol,
          ticker,
          configuredAlias: resolveCatalogAlias(this.configuredCatalog, ticker),
        });
      }
    }

    let partial = false;
    if (unresolved.length > 0) {
      try {
        const catalogResult = await this.loadTickerCatalog();
        partial ||= catalogResult.degraded;
        for (const { symbol, ticker, configuredAlias } of unresolved) {
          const officialExact = resolveCatalogExact(catalogResult.value, ticker);
          const officialAlias = resolveCatalogAlias(catalogResult.value, ticker);
          const aliasesConflict =
            configuredAlias &&
            officialAlias &&
            configuredAlias !== officialAlias;
          const cik = officialExact ?? (aliasesConflict ? null : officialAlias ?? configuredAlias);
          if (!cik) {
            partial = true;
            continue;
          }
          const symbols = plan.get(cik) ?? new Set<CanonicalSymbol>();
          symbols.add(symbol);
          plan.set(cik, symbols);
        }
      } catch (error) {
        if (plan.size === 0) throw error;
        partial = true;
      }
    }

    const plans = [...plan].sort(([left], [right]) => left.localeCompare(right));
    const outcomes = await Promise.allSettled(
      plans.map(async ([cik, symbols]) => ({
        cik,
        symbols,
        filings: await this.loadSubmissions(cik),
      })),
    );
    const fulfilled = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0 && fulfilled.length === 0) {
      throw failures[0].reason;
    }
    partial ||= failures.length > 0;

    const byAccession = new Map<
      string,
      { filing: SecFiling; symbols: Set<CanonicalSymbol> }
    >();
    for (const result of fulfilled) {
      for (const filing of result.filings) {
        if (Date.parse(filing.acceptedAt) < request.sinceTime) continue;
        const existing = byAccession.get(filing.accessionNumber);
        if (!existing) {
          byAccession.set(filing.accessionNumber, {
            filing,
            symbols: new Set(result.symbols),
          });
          continue;
        }
        for (const symbol of result.symbols) existing.symbols.add(symbol);
        if (filing.acceptedAt > existing.filing.acceptedAt) {
          existing.filing = filing;
        }
      }
    }

    const receivedAt = new Date(this.now()).toISOString();
    const events = [...byAccession.values()]
      .sort(
        (left, right) =>
          right.filing.acceptedAt.localeCompare(left.filing.acceptedAt) ||
          left.filing.accessionNumber.localeCompare(right.filing.accessionNumber),
      )
      .slice(0, request.limit)
      .map<RawSourceEvent>(({ filing, symbols }) =>
        filingEvent(
          filing,
          [...symbols].sort() as CanonicalSymbol[],
          receivedAt,
        ),
      );

    return partial ? { events, coverage: "partial" } : events;
  }

  async getHealth(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    if (!this.enabled) {
      return {
        provider: this.name,
        status: "unconfigured",
        checkedAt,
        latestObservedAt: null,
        message: SEC_DORMANT_MESSAGE,
      };
    }
    if (!this.userAgent) {
      return {
        provider: this.name,
        status: "unconfigured",
        checkedAt,
        latestObservedAt: null,
        message: "SEC_USER_AGENT is not configured.",
      };
    }
    if (!this.coordinator) {
      return {
        provider: this.name,
        status: "unconfigured",
        checkedAt,
        latestObservedAt: null,
        message: SEC_COORDINATOR_REQUIRED_MESSAGE,
      };
    }
    try {
      const state = await this.coordinator.getStatus();
      if (state.status === "ready") {
        return {
          provider: this.name,
          status: "healthy",
          checkedAt,
          latestObservedAt: null,
        };
      }
      return {
        provider: this.name,
        status: "degraded",
        checkedAt,
        latestObservedAt: null,
        message:
          state.status === "cooldown"
            ? SEC_COOLDOWN_MESSAGE
            : SEC_COORDINATOR_UNAVAILABLE_MESSAGE,
      };
    } catch {
      return {
        provider: this.name,
        status: "degraded",
        checkedAt,
        latestObservedAt: null,
        message: SEC_COORDINATOR_UNAVAILABLE_MESSAGE,
      };
    }
  }
}
