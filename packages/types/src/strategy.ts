/**
 * The strategy model.
 *
 * Two shapes, deliberately:
 *
 *   `Strategy`           what the user edits. Rules, names, readable numbers.
 *   `NormalizedStrategy` what gets encrypted. Four fixed-width integers.
 *
 * The second shape is not a convenience. Arcis compiles to fixed MPC circuits:
 * no `Vec`, no variable-length loops, no data-dependent control flow. A circuit
 * that could hold "however many rules the user added" cannot be expressed, so
 * the editable model has to collapse into a fixed struct before it can ever be
 * evaluated. Keeping the collapse explicit — and tested — is what stops the UI
 * from drifting into shapes the circuit cannot run.
 *
 * See ARCHITECTURE.md §6 and RESEARCH.md §2.7.
 */

/** Price precision used everywhere prices are compared. */
export const PRICE_DECIMALS = 6;

/**
 * Sentinels for rules the user left off.
 *
 * Chosen so a disabled rule's comparison is simply never true, rather than
 * being skipped. In MPC both branches of a conditional execute regardless, so
 * a disabled rule costs the same as an enabled one and is indistinguishable
 * from the outside. "Off" must not be observable.
 */
export const NEVER_BUY = 0n; // price < 0 is never true
export const NEVER_SELL = 18_446_744_073_709_551_615n; // u64::MAX; price > MAX never true
export const NO_STOP = 0n;

export const MAX_NAME_LENGTH = 40;

export type RuleKind = "entry" | "exit" | "stop";

/** A single rule. The operator is implied by the kind, not chosen freely. */
export type Rule = {
  kind: RuleKind;
  /** Human-entered price, e.g. "150.25". Kept as a string until normalized. */
  value: string;
};

export type Strategy = {
  name: string;
  /** At most one rule of each kind. */
  rules: Rule[];
  /** Fraction of the vault committed per trade, in basis points. */
  sizeBps: number;
};

/** Exactly what gets encrypted. Mirrors the Arcis struct field for field. */
export type NormalizedStrategy = {
  entryBelow: bigint;
  exitAbove: bigint;
  stopBelow: bigint;
  sizeBps: number;
};

export const OPERATOR: Record<RuleKind, string> = {
  entry: "<",
  exit: ">",
  stop: "<",
};

export const ACTION: Record<RuleKind, string> = {
  entry: "BUY",
  exit: "SELL",
  stop: "SELL ALL",
};

export const emptyStrategy = (): Strategy => ({
  name: "",
  rules: [],
  sizeBps: 1_000,
});

/** Parse a price string to fixed-point. Same reasoning as token amounts. */
export function toPriceUnits(value: string): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || !/^\d*\.?\d*$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > PRICE_DECIMALS) return null;
  const combined = `${whole || "0"}${fraction.padEnd(PRICE_DECIMALS, "0")}`;
  const result = BigInt(combined);
  return result === 0n ? null : result;
}

export type ValidationError = { field: string; message: string };

/**
 * Validate a draft.
 *
 * The ordering rules are not stylistic. A strategy whose sell price sits below
 * its buy price round-trips on every evaluation, paying spread and fees each
 * time; a stop above the entry fires the moment it buys. Both are ways to lose
 * money steadily while looking like they are working, so they are refused at
 * the edit step rather than discovered later from the trade history.
 */
export function validateStrategy(
  s: Strategy,
  maxSizeBps: number
): ValidationError[] {
  const errors: ValidationError[] = [];

  const name = s.name.trim();
  if (name.length === 0) {
    errors.push({ field: "name", message: "Give the strategy a name." });
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    });
  }

  const seen = new Set<RuleKind>();
  for (const rule of s.rules) {
    if (seen.has(rule.kind)) {
      errors.push({
        field: rule.kind,
        message: "Only one rule of each kind.",
      });
    }
    seen.add(rule.kind);
    if (toPriceUnits(rule.value) === null) {
      errors.push({
        field: rule.kind,
        message: `Enter a price above zero, with at most ${PRICE_DECIMALS} decimals.`,
      });
    }
  }

  if (s.rules.length === 0) {
    errors.push({ field: "rules", message: "Add at least one rule." });
  }

  if (!Number.isInteger(s.sizeBps) || s.sizeBps <= 0) {
    errors.push({ field: "sizeBps", message: "Trade size must be above zero." });
  } else if (s.sizeBps > maxSizeBps) {
    errors.push({
      field: "sizeBps",
      message: `Your vault caps trades at ${maxSizeBps / 100}%.`,
    });
  }

  // Ordering checks only run once the individual prices parse.
  const price = (kind: RuleKind) => {
    const rule = s.rules.find((r) => r.kind === kind);
    return rule ? toPriceUnits(rule.value) : null;
  };
  const entry = price("entry");
  const exit = price("exit");
  const stop = price("stop");

  if (entry !== null && exit !== null && exit <= entry) {
    errors.push({
      field: "exit",
      message: "Sell price must be above the buy price, or it sells the moment it buys.",
    });
  }
  if (entry !== null && stop !== null && stop >= entry) {
    errors.push({
      field: "stop",
      message: "Stop must be below the buy price, or it triggers immediately.",
    });
  }

  return errors;
}

/**
 * Collapse a validated draft into the four integers the circuit evaluates.
 *
 * Throws on an invalid draft rather than emitting a silently wrong strategy:
 * this is the last point where a mistake is still cheap.
 */
export function normalize(s: Strategy, maxSizeBps: number): NormalizedStrategy {
  const errors = validateStrategy(s, maxSizeBps);
  if (errors.length > 0) {
    throw new Error(`Cannot normalize an invalid strategy: ${errors[0].message}`);
  }

  const price = (kind: RuleKind, fallback: bigint) => {
    const rule = s.rules.find((r) => r.kind === kind);
    if (!rule) return fallback;
    return toPriceUnits(rule.value) ?? fallback;
  };

  return {
    entryBelow: price("entry", NEVER_BUY),
    exitAbove: price("exit", NEVER_SELL),
    stopBelow: price("stop", NO_STOP),
    sizeBps: s.sizeBps,
  };
}

/** Render a rule the way it will actually be evaluated. */
export function describeRule(rule: Rule): string {
  return `PRICE ${OPERATOR[rule.kind]} ${rule.value || "—"} → ${ACTION[rule.kind]}`;
}
