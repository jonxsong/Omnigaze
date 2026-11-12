import { describe, expect, it, vi } from "vitest";
import { instrumentApiRoute } from "@/lib/api-telemetry";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RESPONSE_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function logger() {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("API route telemetry", () => {
  it.each([
    "api.market.NASDAQ:NVDA",
    "api.market.snapshots.get?owner=private",
    `api.${"a".repeat(100)}`,
  ])("rejects a non-static or unbounded operation label: %s", (operation) => {
    expect(() =>
      instrumentApiRoute({ operation }, () => new Response("ok")),
    ).toThrow("bounded, lowercase static labels");
  });

  it("preserves the response and handler arguments while adding correlation and timing", async () => {
    const telemetryLogger = logger();
    const handler = vi.fn(
      async (request: Request, context: { params: Promise<{ id: string }> }) => {
        expect(request.url).toContain("do-not-log-query");
        expect(await context.params).toEqual({ id: "item-1" });
        return Response.json(
          { ok: true },
          {
            status: 201,
            statusText: "Created",
            headers: {
              "Cache-Control": "private, no-store",
              "Server-Timing": "database;dur=4.0",
              "X-Custom": "preserved",
            },
          },
        );
      },
    );
    const wrapped = instrumentApiRoute(
      { operation: "api.test.post", slowMs: 100 },
      handler,
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(22.34),
      },
    );
    const request = new Request(
      "https://omnigaze.test/api/test?secret=do-not-log-query",
    );
    const context = { params: Promise.resolve({ id: "item-1" }) };

    const response = await wrapped(request, context);

    expect(handler).toHaveBeenCalledWith(request, context);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-custom")).toBe("preserved");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(response.headers.get("server-timing")).toBe(
      "database;dur=4.0, omnigaze;dur=12.3",
    );
    expect(telemetryLogger.info).toHaveBeenCalledOnce();
    expect(telemetryLogger.info).toHaveBeenCalledWith({
      event: "omnigaze.api_request",
      schemaVersion: 1,
      operation: "api.test.post",
      requestId: REQUEST_ID,
      status: 201,
      outcome: "success",
      durationMs: 12.3,
      slow: false,
    });
    expect(telemetryLogger.warn).not.toHaveBeenCalled();
    expect(telemetryLogger.error).not.toHaveBeenCalled();
    expect(JSON.stringify(telemetryLogger.info.mock.calls)).not.toContain(
      "do-not-log-query",
    );
  });

  it("classifies ordinary client errors without escalating their log level", async () => {
    const telemetryLogger = logger();
    const wrapped = instrumentApiRoute(
      { operation: "api.test.get", slowMs: 100 },
      () => Response.json({ code: "invalid_request" }, { status: 400 }),
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(5),
      },
    );

    const response = await wrapped();

    expect(response.status).toBe(400);
    expect(telemetryLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "client_error",
        status: 400,
        slow: false,
      }),
    );
    expect(telemetryLogger.warn).not.toHaveBeenCalled();
    expect(telemetryLogger.error).not.toHaveBeenCalled();
  });

  it("replaces handler response IDs and logs server responses as errors", async () => {
    const telemetryLogger = logger();
    const wrapped = instrumentApiRoute(
      { operation: "api.test.get" },
      () =>
        Response.json(
          { requestId: RESPONSE_REQUEST_ID },
          {
            status: 503,
            headers: { "X-Request-ID": RESPONSE_REQUEST_ID },
          },
        ),
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20),
      },
    );

    const response = await wrapped();

    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(await response.json()).toEqual({ requestId: RESPONSE_REQUEST_ID });
    expect(telemetryLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        outcome: "server_error",
        status: 503,
      }),
    );
    expect(telemetryLogger.info).not.toHaveBeenCalled();
    expect(telemetryLogger.warn).not.toHaveBeenCalled();
  });

  it("warns for slow non-server responses", async () => {
    const telemetryLogger = logger();
    const wrapped = instrumentApiRoute(
      { operation: "api.test.get", slowMs: 25 },
      () => new Response(null, { status: 204 }),
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
      },
    );

    const response = await wrapped();

    expect(response.status).toBe(204);
    expect(telemetryLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 25, slow: true }),
    );
    expect(telemetryLogger.info).not.toHaveBeenCalled();
    expect(telemetryLogger.error).not.toHaveBeenCalled();
  });

  it("turns escaped failures into one correlated, sanitized API error", async () => {
    const telemetryLogger = logger();
    const unexpectedErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const wrapped = instrumentApiRoute(
      {
        operation: "api.test.post",
        unexpectedError: {
          code: "test_failed",
          message: "The test request could not be completed.",
          status: 502,
        },
      },
      () => {
        throw new Error(
          "do-not-log-secret owner-a https://omnigaze.test/private?token=secret",
        );
      },
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(3).mockReturnValueOnce(7),
      },
    );

    const response = await wrapped();
    const body = (await response.json()) as {
      code: string;
      error: string;
      requestId: string;
    };

    expect(response.status).toBe(502);
    expect(body).toEqual({
      code: "test_failed",
      error: "The test request could not be completed.",
      requestId: REQUEST_ID,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(unexpectedErrorSpy).toHaveBeenCalledWith(
      "omnigaze.unexpected_failure",
      {
        event: "omnigaze.unexpected_failure",
        operation: "api.test.post",
        requestId: REQUEST_ID,
        failureKind: "error",
      },
    );
    expect(telemetryLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "api.test.post",
        requestId: REQUEST_ID,
        outcome: "server_error",
        status: 502,
      }),
    );
    expect(telemetryLogger.info).not.toHaveBeenCalled();
    expect(telemetryLogger.warn).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify([
      unexpectedErrorSpy.mock.calls,
      telemetryLogger.error.mock.calls,
    ]);
    expect(serializedLogs).not.toContain("do-not-log-secret");
    expect(serializedLogs).not.toContain("owner-a");
    expect(serializedLogs).not.toContain("token=secret");

    unexpectedErrorSpy.mockRestore();
  });

  it.each([
    ["negative", 20, 10],
    ["non-finite", 20, Number.POSITIVE_INFINITY],
  ])("clamps %s clock deltas", async (_label, startedAt, completedAt) => {
    const telemetryLogger = logger();
    const wrapped = instrumentApiRoute(
      { operation: "api.test.get" },
      () => new Response("ok"),
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi
          .fn()
          .mockReturnValueOnce(startedAt)
          .mockReturnValueOnce(completedAt),
      },
    );

    const response = await wrapped();

    expect(response.headers.get("server-timing")).toBe(
      "omnigaze;dur=0.0",
    );
    expect(telemetryLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 0 }),
    );
  });

  it("replaces a reflected valid client response ID instead of propagating it", async () => {
    const telemetryLogger = logger();
    const wrapped = instrumentApiRoute(
      { operation: "api.test.get" },
      (request: Request) =>
        new Response("ok", {
          headers: {
            "X-Request-ID": request.headers.get("X-Request-ID") ?? "missing",
          },
        }),
      {
        createRequestId: () => REQUEST_ID,
        logger: telemetryLogger,
        now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1),
      },
    );

    const response = await wrapped(
      new Request("https://omnigaze.test/api/test", {
        headers: { "X-Request-ID": RESPONSE_REQUEST_ID },
      }),
    );

    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(telemetryLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
  });
});
