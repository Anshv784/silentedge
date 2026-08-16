import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SilentEdge — private trading strategies on Solana",
  description:
    "Run a rule-based trading strategy on Solana without handing anyone your funds, and without publishing the rules you trade on.",
};

/**
 * The public landing page.
 *
 * Every claim here is one the repository can back. The temptation on a page
 * like this is to describe the system you wish you had shipped — "impossible
 * to front-run", "your strategy is invisible" — and each of those is false in a
 * way a careful reader could check. What is written instead is the narrower
 * true version, because the narrower version is still the interesting one and
 * the broad version is the kind of claim this project exists to avoid.
 *
 * See SECURITY_AUDIT.md for what is enforced versus merely coded, and
 * docs/what-is-private.md for the limits of the privacy claim in particular.
 */

function Rule() {
  return <div className="h-px w-full bg-[var(--color-rule)]" aria-hidden />;
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="relative border-t border-[var(--color-rule)] pt-4">
      <span className="tabular text-[11px] tracking-[0.16em] text-[var(--color-ink-soft)]">
        {n}
      </span>
      <h3 className="mt-2 text-[15px] font-medium">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
        {children}
      </p>
    </li>
  );
}

export default function Landing() {
  return (
    <main className="grid-field min-h-dvh">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-8 sm:px-8">
        {/* ---------------------------------------------------- nav */}
        <header className="mb-16 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-rule)] pb-6 sm:mb-24">
          <span className="text-[15px] font-medium tracking-[0.04em]">
            SilentEdge
          </span>
          <nav className="flex items-center gap-5 text-[13px]">
            <a
              className="text-[var(--color-ink-soft)] underline-offset-4 hover:underline"
              href="https://github.com/Anshv784/silentedge"
              rel="noreferrer noopener"
              target="_blank"
            >
              Source
            </a>
            <Link
              href="/app"
              className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-4 py-2 text-white transition-opacity hover:opacity-90"
            >
              Open app
            </Link>
          </nav>
        </header>

        {/* ---------------------------------------------------- hero */}
        <section className="mb-20 sm:mb-28">
          <h1 className="max-w-3xl text-[30px] font-medium leading-[1.15] tracking-[-0.01em] sm:text-[44px]">
            Trade on rules you don&rsquo;t have to publish.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-ink-soft)]">
            SilentEdge runs a rule-based strategy against your own Solana vault.
            You keep the only key that can withdraw. The prices you trade on are
            evaluated inside multi-party computation, so they are not readable by
            us, by the node operators, or from the chain.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/app"
              className="border border-[var(--color-signal)] bg-[var(--color-signal)] px-5 py-2.5 text-[14px] text-white transition-opacity hover:opacity-90"
            >
              Open the app
            </Link>
            <Link
              href="/app"
              className="border border-[var(--color-rule)] px-5 py-2.5 text-[14px] transition-colors hover:bg-[var(--color-panel)]"
            >
              See a vault
            </Link>
            <span className="text-[12px] text-[var(--color-ink-soft)]">
              Devnet. Not audited.
            </span>
          </div>
        </section>

        {/* ---------------------------------------------------- problem */}
        <section className="mb-20 grid gap-10 sm:mb-28 lg:grid-cols-2">
          <div>
            <h2 className="text-[20px] font-medium tracking-[-0.01em]">
              Two things usually go wrong
            </h2>
            <p className="mt-4 text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
              A hosted trading bot asks you for custody, or for your strategy, and
              usually for both. Custody means someone else can move your money.
              Handing over your rules means whoever runs the service can read
              them, copy them, or trade ahead of them.
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
              Doing it yourself avoids both and costs you a machine that has to
              stay online, holding a key that can trade.
            </p>
          </div>
          <div className="border border-[var(--color-rule)] bg-[var(--color-panel)] p-6">
            <h2 className="text-[20px] font-medium tracking-[-0.01em]">
              What this does instead
            </h2>
            <ul className="mt-4 space-y-3 text-[14px] leading-relaxed">
              <li>
                <strong>Funds stay yours.</strong> The vault is a program-derived
                account. No instruction in the program accepts an operator
                authority, so there is no key we could use to withdraw.
              </li>
              <li>
                <strong>Rules stay unread.</strong> Your thresholds are encrypted
                in your browser and evaluated under MPC. Nobody sees the numbers,
                including us.
              </li>
              <li>
                <strong>Trades stay bounded.</strong> Each trade is authorized by
                the computation for one side, one size, and about a minute — and
                checked again on chain before anything moves.
              </li>
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------- how */}
        <section className="mb-20 sm:mb-28">
          <h2 className="mb-8 text-[20px] font-medium tracking-[-0.01em]">
            How it works
          </h2>
          <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <Step n="01" title="Create a vault">
              A Solana account your wallet owns. Deposit and withdraw whenever
              you like — withdrawals never depend on us being online.
            </Step>
            <Step n="02" title="Write the rules">
              Buy below a price, take profit above one, stop out under another.
              They are encrypted before they leave the page.
            </Step>
            <Step n="03" title="The computation decides">
              A network of nodes evaluates your rules against a Pyth price feed
              without any of them learning the rules, and signs the result.
            </Step>
            <Step n="04" title="The trade executes">
              Anyone can submit the authorized trade, including you. It swaps
              through Jupiter and the proceeds land back in your vault.
            </Step>
          </ol>
        </section>

        <Rule />

        {/* ---------------------------------------------------- honesty */}
        <section className="my-16">
          <h2 className="text-[20px] font-medium tracking-[-0.01em]">
            What it does not do
          </h2>
          <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
            Being precise about this is the point of the project, so it is on the
            front page rather than in a footnote.
          </p>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div className="border border-[var(--color-rule)] p-5">
              <h3 className="text-[14px] font-medium">
                Your trades are public
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
                Solana is a public ledger. Anyone can see that a trade happened,
                its size, and the price at the time. Enough observed trades will
                narrow down the thresholds behind them. Your rules are unread,
                not unknowable.
              </p>
            </div>
            <div className="border border-[var(--color-rule)] p-5">
              <h3 className="text-[14px] font-medium">
                It is not front-running proof
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
                An authorization is visible on chain for the short window before
                it is spent. A slippage floor derived from the oracle bounds what
                that can cost you; it does not eliminate the exposure.
              </p>
            </div>
            <div className="border border-[var(--color-rule)] p-5">
              <h3 className="text-[14px] font-medium">Nobody has audited it</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
                The security work is self-assessed and published, including the
                parts that are implemented but not yet covered by a test that
                would catch their removal.
              </p>
            </div>
            <div className="border border-[var(--color-rule)] p-5">
              <h3 className="text-[14px] font-medium">
                The program can still be upgraded
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
                Today the upgrade authority is a single key. Until it moves to a
                timelocked multisig, &ldquo;non-custodial&rdquo; describes the
                deployed code and not every future version of it.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- cta */}
        <section className="border border-[var(--color-rule)] bg-[var(--color-panel)] px-6 py-10 text-center">
          <h2 className="text-[20px] font-medium tracking-[-0.01em]">
            Try it on devnet
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
            Connecting a wallet only reads public balances. Nothing is signed and
            no funds move until you ask.
          </p>
          <Link
            href="/app"
            className="mt-6 inline-block border border-[var(--color-signal)] bg-[var(--color-signal)] px-5 py-2.5 text-[14px] text-white transition-opacity hover:opacity-90"
          >
            Open the app
          </Link>
        </section>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-rule)] pt-6 text-[12px] text-[var(--color-ink-soft)]">
          <span>Devnet only. Do not use with funds you cannot lose.</span>
          <a
            className="underline-offset-4 hover:underline"
            href="https://github.com/Anshv784/silentedge"
            rel="noreferrer noopener"
            target="_blank"
          >
            Read the code
          </a>
        </footer>
      </div>
    </main>
  );
}
