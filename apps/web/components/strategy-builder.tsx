"use client";

import { useMemo, useState } from "react";
import {
  ACTION,
  MAX_NAME_LENGTH,
  OPERATOR,
  type Rule,
  type RuleKind,
  type Strategy,
  emptyStrategy,
  normalize,
  validateStrategy,
} from "@silentedge/types";
import { QUOTE_SYMBOL, BASE_SYMBOL } from "@silentedge/config";

const KINDS: { kind: RuleKind; label: string; hint: string }[] = [
  { kind: "entry", label: "Buy below", hint: `Spend ${QUOTE_SYMBOL} on ${BASE_SYMBOL}` },
  { kind: "exit", label: "Sell above", hint: `Take profit back into ${QUOTE_SYMBOL}` },
  { kind: "stop", label: "Stop below", hint: "Exit the whole position" },
];

const inputClass =
  "tabular w-full border border-[var(--color-rule)] bg-white px-3 py-2 text-[14px] " +
  "placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-signal)] focus:outline-none";

export function StrategyBuilder({
  maxSizeBps,
  onCancel,
  onSave,
}: {
  maxSizeBps: number;
  onCancel: () => void;
  onSave: (s: Strategy) => void;
}) {
  const [draft, setDraft] = useState<Strategy>(emptyStrategy);
  const [touched, setTouched] = useState(false);

  const errors = useMemo(
    () => validateStrategy(draft, maxSizeBps),
    [draft, maxSizeBps]
  );
  const errorFor = (field: string) =>
    touched ? errors.find((e) => e.field === field)?.message : undefined;

  // The live preview is only meaningful once the draft actually normalizes.
  const preview = useMemo(() => {
    try {
      return normalize(draft, maxSizeBps);
    } catch {
      return null;
    }
  }, [draft, maxSizeBps]);

  const ruleFor = (kind: RuleKind) => draft.rules.find((r) => r.kind === kind);

  function setRule(kind: RuleKind, value: string) {
    setDraft((d) => {
      const rest = d.rules.filter((r) => r.kind !== kind);
      const next: Rule[] = value.trim() === "" ? rest : [...rest, { kind, value }];
      // Keep a stable order so the rule sheet does not jump as rules are typed.
      next.sort(
        (a, b) =>
          KINDS.findIndex((k) => k.kind === a.kind) -
          KINDS.findIndex((k) => k.kind === b.kind)
      );
      return { ...d, rules: next };
    });
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-5">
        <label
          htmlFor="strategy-name"
          className="mb-2 block text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]"
        >
          Name
        </label>
        <input
          id="strategy-name"
          className={inputClass}
          placeholder="Range trade"
          maxLength={MAX_NAME_LENGTH + 10}
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <FieldError message={errorFor("name")} />
      </div>

      <fieldset className="mb-5">
        <legend className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
          Rules
        </legend>
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          Leave a rule blank to switch it off. Every rule compares the{" "}
          {BASE_SYMBOL} price to one number — that is the whole language for now.
        </p>

        <div className="space-y-3">
          {KINDS.map(({ kind, label, hint }) => {
            const rule = ruleFor(kind);
            return (
              <div key={kind}>
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor={`rule-${kind}`}
                    className="w-[86px] shrink-0 text-[13px]"
                  >
                    {label}
                  </label>
                  <span className="tabular text-[13px] text-[var(--color-ink-soft)]">
                    {OPERATOR[kind]}
                  </span>
                  <input
                    id={`rule-${kind}`}
                    className={`${inputClass} w-28 flex-1`}
                    inputMode="decimal"
                    placeholder="—"
                    value={rule?.value ?? ""}
                    onChange={(e) => setRule(kind, e.target.value)}
                  />
                  <span className="tabular w-[76px] shrink-0 text-right text-[11px] text-[var(--color-ink-soft)]">
                    {rule ? `→ ${ACTION[kind]}` : "off"}
                  </span>
                </div>
                <p className="ml-[94px] mt-1 text-[11px] text-[var(--color-ink-soft)]">
                  {hint}
                </p>
                <div className="ml-[94px]">
                  <FieldError message={errorFor(kind)} />
                </div>
              </div>
            );
          })}
        </div>
        <div>
          <FieldError message={errorFor("rules")} />
        </div>
      </fieldset>

      <div className="mb-5">
        <label
          htmlFor="strategy-size"
          className="mb-2 block text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]"
        >
          Trade size
        </label>
        <div className="flex items-center gap-3">
          <input
            id="strategy-size"
            type="range"
            min={100}
            max={maxSizeBps}
            step={100}
            value={Math.min(draft.sizeBps, maxSizeBps)}
            onChange={(e) =>
              setDraft((d) => ({ ...d, sizeBps: Number(e.target.value) }))
            }
            className="flex-1 accent-[var(--color-signal)]"
          />
          <span className="tabular w-16 text-right text-[14px]">
            {(draft.sizeBps / 100).toFixed(0)}%
          </span>
        </div>
        <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
          Share of the vault committed per trade. Your vault caps this at{" "}
          {maxSizeBps / 100}%.
        </p>
        <FieldError message={errorFor("sizeBps")} />
      </div>

      {/* What actually gets encrypted — shown so it is not a black box. */}
      <div className="mb-5 border border-[var(--color-rule)] bg-[var(--color-paper)] px-4 py-3">
        <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-soft)]">
          What gets encrypted
        </div>
        {preview ? (
          <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
            <Row k="entry_below" v={preview.entryBelow} />
            <Row k="exit_above" v={preview.exitAbove} />
            <Row k="stop_below" v={preview.stopBelow} />
            <Row k="size_bps" v={BigInt(preview.sizeBps)} />
          </dl>
        ) : (
          <p className="text-[12px] text-[var(--color-ink-soft)]">
            Finish the rules to see it.
          </p>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
          Four integers, fixed width. A rule you switched off still occupies its
          slot with a value that can never match, so an observer cannot tell
          which rules you use.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-4 py-2 text-[13px] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setTouched(true);
            if (errors.length === 0) onSave(draft);
          }}
          disabled={touched && errors.length > 0}
        >
          Save draft
        </button>
        <button
          className="border border-[var(--color-rule)] px-4 py-2 text-[13px] transition-colors hover:bg-[var(--color-paper)]"
          onClick={onCancel}
        >
          Cancel
        </button>
        {touched && errors.length > 0 ? (
          <span className="text-[11px] text-[var(--color-exposed)]">
            {errors.length} thing{errors.length > 1 ? "s" : ""} to fix.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: bigint }) {
  return (
    <>
      <dt className="text-[var(--color-ink-soft)]">{k}</dt>
      <dd className="text-right">{v.toString()}</dd>
    </>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-[11px] text-[var(--color-exposed)]">
      {message}
    </p>
  );
}
