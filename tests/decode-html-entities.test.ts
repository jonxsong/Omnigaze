import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "@/lib/decode-html-entities";

describe("plain-text HTML entity decoding", () => {
  it("decodes common named, decimal, hexadecimal, and double-encoded entities", () => {
    expect(
      decodeHtmlEntities(
        "NVIDIA&#39;s R&amp;D &mdash; &#x4E2D;&#22269; &amp;amp; partners",
      ),
    ).toBe("NVIDIA's R&D — 中国 & partners");
  });

  it("preserves unknown, malformed, control, surrogate, and out-of-range entities", () => {
    const value =
      "&unknown; &#xZZ; &#10; &#x80; &#xD800; &#x110000; &amp without-semicolon";
    expect(decodeHtmlEntities(value)).toBe(value);
  });

  it("remains plain text when decoded content resembles executable markup", () => {
    const decoded = decodeHtmlEntities(
      "&lt;img src=x onerror=alert(1)&gt; &amp; ordinary text",
    );
    expect(decoded).toBe("<img src=x onerror=alert(1)> & ordinary text");
    expect(renderToStaticMarkup(createElement("span", null, decoded))).toBe(
      "<span>&lt;img src=x onerror=alert(1)&gt; &amp; ordinary text</span>",
    );
  });
});
