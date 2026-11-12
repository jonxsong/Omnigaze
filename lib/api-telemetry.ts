import { unexpectedApiError } from "@/lib/unexpected-failure";

const EVENT_NAME = "omnigaze.api_request";
const SCHEMA_VERSION = 1;
const DEFAULT_SLOW_MS = 1_000;
const DEFAULT_SUCCESS_SAMPLE_RATE = 1;
const MAX_DURATION_MS = 60 * 60 * 1_000;
const OPERATION_PATTERN =
  /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9_]*)*$/;
const MAX_OPERATION_LENGTH = 96;

type ApiRouteHandler<Arguments extends unknown[]> = (
  ...args: Arguments
) => Response | Promise<Response>;

type TelemetryLogger = Pick<Console, "error" | "info" | "warn">;

export interface ApiTelemetryOptions {
  /** A static, code-owned label. Never derive this from a request. */
  operation: string;
  /** Disable success sampling for protocols whose errors can use HTTP 2xx. */
  sampleSuccesses?: boolean;
  slowMs?: number;
  unexpectedError?: {
    code: string;
    message: string;
    status?: number;
  };
}

interface ApiTelemetryDependencies {
  createRequestId: () => string;
  getSuccessSampleRate: () => number;
  logger: TelemetryLogger;
  now: () => number;
}

const defaultDependencies: ApiTelemetryDependencies = {
  createRequestId: () => crypto.randomUUID(),
  getSuccessSampleRate: () => {
    const configured =
      process.env.OMNIGAZE_TELEMETRY_SUCCESS_SAMPLE_RATE?.trim();
    return configured ? Number(configured) : DEFAULT_SUCCESS_SAMPLE_RATE;
  },
  logger: console,
  now: () => performance.now(),
};

export interface ApiRequestTelemetry {
  event: typeof EVENT_NAME;
  schemaVersion: typeof SCHEMA_VERSION;
  operation: string;
  requestId: string;
  status: number;
  outcome: "success" | "client_error" | "server_error";
  durationMs: number;
  slow: boolean;
}

function normalizedDuration(startedAt: number, completedAt: number) {
  const elapsed = completedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.round(Math.min(elapsed, MAX_DURATION_MS) * 10) / 10;
}

function normalizedSlowThreshold(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_SLOW_MS;
}

function normalizedSuccessSampleRate(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_SUCCESS_SAMPLE_RATE;
}

function deterministicSample(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function assertStaticOperation(operation: string) {
  if (
    operation.length === 0 ||
    operation.length > MAX_OPERATION_LENGTH ||
    !OPERATION_PATTERN.test(operation)
  ) {
    throw new Error(
      "API telemetry operations must be bounded, lowercase static labels.",
    );
  }
}

function outcomeForStatus(status: number): ApiRequestTelemetry["outcome"] {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}

function withTelemetryHeaders(
  response: Response,
  requestId: string,
  durationMs: number,
) {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  headers.append("Server-Timing", `omnigaze;dur=${durationMs.toFixed(1)}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logTelemetry(
  logger: TelemetryLogger,
  telemetry: ApiRequestTelemetry,
  successSampleRate: number,
) {
  if (telemetry.status >= 500) {
    logger.error(telemetry);
    return;
  }
  if (telemetry.slow) {
    logger.warn(telemetry);
    return;
  }
  if (
    telemetry.outcome === "success" &&
    deterministicSample(telemetry.requestId) >= successSampleRate
  ) {
    return;
  }
  logger.info(telemetry);
}

/**
 * Adds privacy-bounded completion telemetry to one HTTP route boundary.
 *
 * The wrapper never reads the Request, route parameters, bodies, identities,
 * URLs, request headers, or thrown error details. Its operation label must be
 * static, and its correlation ID is always generated at this boundary.
 */
export function instrumentApiRoute<Arguments extends unknown[]>(
  options: ApiTelemetryOptions,
  handler: ApiRouteHandler<Arguments>,
  dependencyOverrides: Partial<ApiTelemetryDependencies> = {},
): (...args: Arguments) => Promise<Response> {
  assertStaticOperation(options.operation);
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const slowMs = normalizedSlowThreshold(options.slowMs);

  return async (...args: Arguments) => {
    const generatedRequestId = dependencies.createRequestId();
    const startedAt = dependencies.now();
    let response: Response;

    try {
      response = await handler(...args);
    } catch (failure) {
      response = unexpectedApiError({
        operation: options.operation,
        failure,
        code: options.unexpectedError?.code ?? "internal_error",
        message:
          options.unexpectedError?.message ?? "The request could not be completed.",
        status: options.unexpectedError?.status ?? 500,
        serverRequestId: generatedRequestId,
      });
    }

    const durationMs = normalizedDuration(startedAt, dependencies.now());
    const requestId = generatedRequestId;
    const telemetry: ApiRequestTelemetry = {
      event: EVENT_NAME,
      schemaVersion: SCHEMA_VERSION,
      operation: options.operation,
      requestId,
      status: response.status,
      outcome: outcomeForStatus(response.status),
      durationMs,
      slow: durationMs >= slowMs,
    };

    logTelemetry(
      dependencies.logger,
      telemetry,
      options.sampleSuccesses === false
        ? 1
        : normalizedSuccessSampleRate(dependencies.getSuccessSampleRate()),
    );
    return withTelemetryHeaders(response, requestId, durationMs);
  };
}
