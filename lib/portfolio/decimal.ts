export const PORTFOLIO_MICRO_SCALE = 1_000_000;
export const MAX_QUANTITY_MICROS = 1_000_000_000_000_000;
export const MAX_AVERAGE_COST_MICROS = 10_000_000_000_000;

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;
const MICRO_SCALE_BIGINT = BigInt(PORTFOLIO_MICRO_SCALE);

export class PortfolioDecimalError extends Error {
  constructor(readonly code: "invalid_decimal" | "out_of_range") {
    super(code);
    this.name = "PortfolioDecimalError";
  }
}

function microsAsBigInt(value: string) {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new PortfolioDecimalError("invalid_decimal");

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * MICRO_SCALE_BIGINT + BigInt(fraction || "0");
}

export function decimalToMicros(
  value: string,
  options: { allowZero: boolean; maxMicros: number },
) {
  if (!Number.isSafeInteger(options.maxMicros) || options.maxMicros < 0) {
    throw new PortfolioDecimalError("out_of_range");
  }
  const micros = microsAsBigInt(value);
  if (
    (!options.allowZero && micros === BigInt(0)) ||
    micros > BigInt(Number.MAX_SAFE_INTEGER) ||
    micros > BigInt(options.maxMicros)
  ) {
    throw new PortfolioDecimalError("out_of_range");
  }
  return Number(micros);
}

export function isPortfolioDecimal(
  value: string,
  options: { allowZero: boolean; maxMicros: number },
) {
  try {
    decimalToMicros(value, options);
    return true;
  } catch {
    return false;
  }
}

function formatBigIntMicros(value: bigint) {
  if (value < BigInt(0)) throw new PortfolioDecimalError("out_of_range");

  const whole = value / MICRO_SCALE_BIGINT;
  const remainder = value % MICRO_SCALE_BIGINT;
  if (remainder === BigInt(0)) return whole.toString();

  const fraction = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return whole.toString() + "." + fraction;
}

export function microsToDecimal(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PortfolioDecimalError("out_of_range");
  }
  return formatBigIntMicros(BigInt(value));
}

export function multiplyMicrosToDecimal(
  quantityMicros: number,
  priceMicros: number,
) {
  if (
    !Number.isSafeInteger(quantityMicros) ||
    !Number.isSafeInteger(priceMicros) ||
    quantityMicros < 0 ||
    priceMicros < 0
  ) {
    throw new PortfolioDecimalError("out_of_range");
  }

  const roundedMicros =
    (BigInt(quantityMicros) *
      BigInt(priceMicros) +
      MICRO_SCALE_BIGINT / BigInt(2)) /
    MICRO_SCALE_BIGINT;
  return formatBigIntMicros(roundedMicros);
}
