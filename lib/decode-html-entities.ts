const MAX_DECODE_PASSES = 2;

const namedEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  bull: "•",
  cent: "¢",
  copy: "©",
  euro: "€",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: "\u00A0",
  ndash: "–",
  pound: "£",
  quot: '"',
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
  yen: "¥",
});

// Entity bodies are deliberately bounded. Requiring a semicolon avoids
// consuming ordinary prose such as "R&D" or ambiguous ampersand sequences.
const entityPattern =
  /&(#(?:[xX][0-9a-fA-F]{1,8}|[0-9]{1,10})|[A-Za-z][A-Za-z0-9]{1,31});/gu;

function isPreservedCodePoint(codePoint: number) {
  return (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

function decodeEntity(body: string, original: string) {
  if (!body.startsWith("#")) {
    return namedEntities[body.toLowerCase()] ?? original;
  }

  const hexadecimal = body[1]?.toLowerCase() === "x";
  const digits = body.slice(hexadecimal ? 2 : 1);
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (isPreservedCodePoint(codePoint)) return original;

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

/**
 * Decodes a conservative, bounded subset of HTML character references into a
 * plain string. It never parses markup or mutates the provider receipt. Callers
 * must continue to render the result as text, never as `innerHTML`.
 */
export function decodeHtmlEntities(value: string) {
  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(entityPattern, (entity, body: string) =>
      decodeEntity(body, entity),
    );
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
