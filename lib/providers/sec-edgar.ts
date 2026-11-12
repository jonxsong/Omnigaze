import type { CanonicalSymbol } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type {
  IntelligenceSourceProvider,
  IntelligenceSourceResult,
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

export class SecEdgarProvider implements IntelligenceSourceProvider {
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

  private async request(url: string) {
    const headers = this.headers();
    await this.acquireRequestSlot();
    await this.coordinator!.acquire();
    const response = await this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
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

  private async loadSubmissions(cik: string) {
    const cached = this.submissionsCache.get(cik);
    if (cached && this.now() - cached.fetchedAt <= SUBMISSIONS_CACHE_TTL_MS) {
      return cached.filings;
    }
    const inFlight = this.submissionsRequests.get(cik);
    if (inFlight) return inFlight;

    const request = (async () => {
      const paddedCik = cik.padStart(10, "0");
      const response = await this.request(
        `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
      );
      if (!response.ok) {
        throw new Error(`SEC submissions failed with ${response.status}`);
      }
      const payload = await readBoundedJson(
        response,
        MAX_SUBMISSIONS_RESPONSE_BYTES,
        "SEC submissions exceeded its bounded response size.",
      );
      const filings = parseSubmissions(payload, cik, this.now());
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
      .map<RawSourceEvent>(({ filing, symbols }) => ({
        source: this.name,
        sourceKind: "sec_filing",
        sourceEventId: filing.accessionNumber,
        receivedAt,
        publishedAt: filing.acceptedAt,
        providerUpdatedAt: filing.acceptedAt,
        payload: {
          ...filing,
          symbols: [...symbols].sort(),
        },
      }));

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
