import { describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";

describe("framework request error instrumentation", () => {
  it("reports only allowlisted context categories", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await onRequestError(
      new Error("do-not-log-framework-secret"),
      {
        path: "/portfolio/owner-a?token=secret",
        method: "GET",
        headers: { cookie: "session=do-not-log" },
      },
      {
        routerKind: "App Router",
        routePath: "/portfolio/[owner]",
        routeType: "render",
        renderSource: "server-rendering",
        revalidateReason: undefined,
      },
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "omnigaze.unexpected_failure",
      expect.objectContaining({
        event: "omnigaze.unexpected_failure",
        operation: "framework.app.render",
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        failureKind: "error",
      }),
    );
    const serializedLogs = JSON.stringify(errorSpy.mock.calls);
    expect(serializedLogs).not.toContain("do-not-log-framework-secret");
    expect(serializedLogs).not.toContain("owner-a");
    expect(serializedLogs).not.toContain("session=");
    expect(serializedLogs).not.toContain("portfolio");

    errorSpy.mockRestore();
  });
});
