import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* Paths resolve from the repo root: every suite is launched through an npm
   script, so cwd is the workspace root. `import.meta.dirname` would be the
   natural choice but the root tsconfig targets a module setting that rejects
   `import.meta`, and this file must typecheck under it. */
const REPO = process.cwd();

/**
 * Source-level wiring guards.
 *
 * These exist because of a specific false pass. `max_oracle_deviation_bps`
 * bounds how far the market may move between a decision and its fill, and
 * `execute_trade` reads its reference from `trade_intent.oracle_price` behind a
 * `> 0` guard. The callback that creates the intent used to set that field to
 * zero, so the band could never fire in production — while three fork tests
 * reported it working, because each of them SEEDS an intent with a non-zero
 * `oraclePrice` rather than producing one the way the program does.
 *
 * The runtime path that would have caught it needs a live Arcium cluster, so it
 * cannot run in a default `npm test`. That is the structural reason the defect
 * survived an audit that specifically claimed to have fixed it.
 *
 * These are deliberately *source* assertions, not behavioural ones. They are
 * weaker than a runtime detector and they are not a substitute for one — what
 * they buy is that deleting either half of the wiring turns a default test run
 * red instead of leaving a settable, documented, UI-displayed number that
 * silently controls nothing. The end-to-end assertion lives in
 * `tests/e2e-devnet.ts`, which needs a cluster.
 */

const LIB = readFileSync(
  join(REPO, "programs", "vault", "src", "lib.rs"),
  "utf8"
);

/** The body of a `pub fn NAME(...) { ... }` block, by brace matching. */
function fnBody(src: string, name: string): string {
  // Some handlers carry a lifetime parameter, e.g. `pub fn execute_trade<'info>(`.
  const m = new RegExp(`pub fn ${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(src);
  expect(m, `fn ${name} not found`).to.not.equal(null);
  const start = m!.index;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated fn ${name}`);
}

/** Source with `//` and `/* *\/` comments removed, so prose cannot satisfy a test. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("oracle deviation wiring", () => {
  it("evaluate_strategy records the price the decision was made at", () => {
    const body = strip(fnBody(LIB, "evaluate_strategy"));
    expect(
      /trade_intent\s*\.\s*oracle_price\s*=/.test(body),
      "evaluate_strategy must stash the decision price into trade_intent.oracle_price — " +
        "the callback has no Pyth account and cannot supply it"
    ).to.equal(true);
  });

  it("the callback does not zero the recorded decision price", () => {
    const body = strip(fnBody(LIB, "evaluate_strategy_v3_callback"));
    expect(
      /oracle_price\s*=\s*0\s*;/.test(body),
      "the callback must not reset trade_intent.oracle_price — zeroing it is " +
        "exactly what made max_oracle_deviation_bps inert while its tests passed"
    ).to.equal(false);
  });

  it("execute_trade still gates the band on a recorded price", () => {
    // If this guard is ever removed the two tests above stop mattering, so the
    // shape of the check is asserted too.
    const body = strip(fnBody(LIB, "execute_trade"));
    expect(
      /intent\s*\.\s*oracle_price\s*>\s*0/.test(body),
      "execute_trade should only apply the band when a decision price was recorded"
    ).to.equal(true);
    expect(
      /OracleDeviationTooLarge/.test(body),
      "execute_trade must still raise OracleDeviationTooLarge"
    ).to.equal(true);
  });
});

describe("committed IDL", () => {
  /**
   * `anchor build` writes the IDL into `target/`, which is gitignored. Both the
   * web app and the executor imported it from there, so a fresh clone could not
   * start either of them — the repository did not run for anyone who had not
   * already built it locally. The copy now lives in `idl/`.
   *
   * A committed generated artifact goes stale silently, so this asserts the
   * copy still describes the program the code talks to.
   */
  it("matches the program address the app connects to", () => {
    const idl = JSON.parse(
      readFileSync(join(REPO, "idl", "vault.json"), "utf8")
    );
    const declared = /declare_id!\("([^"]+)"\)/.exec(LIB);
    expect(declared, "declare_id! not found in lib.rs").to.not.equal(null);
    expect(
      idl.address,
      "idl/vault.json is stale — rerun `anchor build` and copy it back (see idl/README.md)"
    ).to.equal(declared![1]);
  });

  it("exposes every instruction the program declares", () => {
    const idl = JSON.parse(
      readFileSync(join(REPO, "idl", "vault.json"), "utf8")
    );
    // Anchor 1.x emits instruction names in snake_case, matching the Rust.
    const inIdl = new Set(idl.instructions.map((i: { name: string }) => i.name));
    const declared = [
      ...LIB.matchAll(/pub fn ([a-z0-9_]+)\s*(?:<[^>]*>)?\s*\(\s*\n?\s*ctx: Context/g),
    ].map((m) => m[1]);
    const missing = declared.filter((n) => !inIdl.has(n));
    expect(
      missing,
      "idl/vault.json is missing instructions the program declares — it is stale"
    ).to.deep.equal([]);
  });
});

describe("executor entrypoint", () => {
  /**
   * The executor imported `@silentedge/sdk/src/arcium.ts`, referenced an `ata`
   * binding that only existed inside two other functions, and imported
   * `./jupiter.js` when only `jupiter.ts` is on disk. Any one of the three
   * stopped it starting, and nothing in the repo would have noticed: it has no
   * test, no typecheck and no CI.
   */
  const SRC = readFileSync(
    join(REPO, "apps", "api", "src", "executor.ts"),
    "utf8"
  );

  it("imports the SDK through its declared entry points", () => {
    expect(
      /@silentedge\/sdk\/src\//.test(SRC),
      "reaching past the package's exports map with a /src/ path does not resolve"
    ).to.equal(false);
  });

  it("does not import a sibling module that is not on disk", () => {
    const specifiers = [...SRC.matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      expect(
        spec.endsWith(".js"),
        `${spec} resolves literally under --experimental-strip-types, and only .ts files exist here`
      ).to.equal(false);
    }
  });
});
