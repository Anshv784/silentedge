/**
 * Amount parsing for token inputs.
 *
 * Uses bigint and string manipulation rather than `Number(value) * 10 **
 * decimals`, because that route is lossy exactly where it matters: `0.1 * 1e6`
 * is 100000.00000000001, and rounding a money amount into place is how
 * off-by-one lamport bugs get shipped.
 *
 * bigint rather than BN so this stays dependency-free and usable from the
 * program tests, the web app, and the SDK alike.
 */

/** Returns null for anything that is not a clean, positive decimal that fits `decimals`. */
export function toBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || !/^\d*\.?\d*$/.test(trimmed)) {
    return null;
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null; // more precision than the mint has

  const combined = `${whole || "0"}${fraction.padEnd(decimals, "0")}`;
  const result = BigInt(combined);
  return result === 0n ? null : result;
}

export function fromBaseUnits(amount: bigint | number | string, decimals: number): number {
  return Number(amount.toString()) / 10 ** decimals;
}
