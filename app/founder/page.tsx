import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  FounderAccessError,
} from "@/lib/founder/auth";
import {
  FOUNDER_KPI_PERIODS,
  getFounderKpis,
  parseFounderKpiPeriod,
} from "@/lib/founder/kpis";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Founder KPIs",
  description: "Private SideSpace operating metrics.",
  robots: { index: false, follow: false },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(values: Record<string, unknown>, key: string) {
  const value = Number(values[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function dateLabel(value: string | null | undefined, withTime = false) {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZone: "UTC",
  }).format(date);
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function MetricCard({
  label,
  value,
  detail,
  tone = "",
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: string;
}) {
  return (
    <article className={`founder-metric ${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function Breakdown({
  title,
  values,
}: {
  title: string;
  values: Record<string, unknown>;
}) {
  const rows = Object.entries(values);
  return (
    <section className="founder-breakdown">
      <h3>{title}</h3>
      {rows.length ? (
        <dl>
          {rows.map(([key]) => (
            <div key={key}>
              <dt>{titleCase(key)}</dt>
              <dd>{count(values, key)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>No rows yet.</p>
      )}
    </section>
  );
}

export default async function FounderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawDays = typeof params.days === "string" ? params.days : undefined;
  const periodDays = parseFounderKpiPeriod(rawDays) ?? 30;

  let report;
  try {
    report = await getFounderKpis(periodDays);
  } catch (error) {
    if (error instanceof FounderAccessError) notFound();
    throw error;
  }

  const snapshot = record(report.snapshot);
  const period = record(report.period_metrics);
  const tracking = record(report.tracking);
  const breakdowns = record(report.breakdowns);
  const requestStatuses = record(breakdowns.request_statuses);
  const paymentStatuses = record(breakdowns.payment_statuses);
  const listingChannels = record(breakdowns.active_listing_channels);
  const daily = report.daily.slice(-14).reverse();

  return (
    <main className="founder-dashboard">
      <header className="founder-dashboard-head">
        <div>
          <Link className="founder-back" href="/dashboard">
            ← Dashboard
          </Link>
          <p className="eyebrow">Private / founders only</p>
          <h1>Operating <em>numbers.</em></h1>
          <p>
            Server-read marketplace metrics for the two people running
            SideSpace. This report excludes demo and internal accounts.
          </p>
        </div>
        <div className="founder-period-control">
          <span>Activity window · UTC</span>
          <nav aria-label="KPI activity window">
            {FOUNDER_KPI_PERIODS.map((days) => (
              <Link
                className={days === periodDays ? "is-current" : ""}
                href={`/founder?days=${days}`}
                key={days}
              >
                {days}d
              </Link>
            ))}
          </nav>
          <small>
            {dateLabel(report.period.start)} – {dateLabel(report.period.end)}
          </small>
        </div>
      </header>

      <section className="founder-truth-note" aria-label="KPI data notes">
        <strong>What is authoritative</strong>
        <p>
          Counts come from Postgres state and trigger-recorded milestones. GMV
          and fees come from verified Stripe payment rows; browser redirects and
          client-side counters cannot change this report. Listing views count a
          single HMAC visitor once per listing per UTC day.
        </p>
        <small>
          Report generated {dateLabel(report.generated_at, true)} UTC · event
          tracking began {dateLabel(String(tracking.event_tracking_started_at ?? ""))}.
        </small>
      </section>

      <section className="founder-report-section" aria-labelledby="founder-snapshot-title">
        <div className="founder-section-head">
          <div>
            <p className="eyebrow">Current state</p>
            <h2 id="founder-snapshot-title">The marketplace as it stands.</h2>
          </div>
          <p>All-time operational snapshot, refreshed on every request.</p>
        </div>
        <div className="founder-metric-grid">
          <MetricCard
            label="Real members"
            value={count(snapshot, "members_total")}
            detail={`${count(snapshot, "members_onboarded")} finished onboarding`}
          />
          <MetricCard
            label="Businesses"
            value={count(snapshot, "businesses_total")}
            detail="Primary or additional Business role"
          />
          <MetricCard
            label="Creators"
            value={count(snapshot, "creators_total")}
            detail="Primary or additional supply role"
          />
          <MetricCard
            label="Active listings"
            value={count(snapshot, "active_listings")}
            detail={`${count(snapshot, "requestable_listings")} currently requestable`}
          />
          <MetricCard
            label="Open requests"
            value={count(snapshot, "open_requests")}
            detail="Pending, countered, accepted, or confirmed"
            tone={count(snapshot, "open_requests") ? "is-alert" : ""}
          />
          <MetricCard
            label="Paid campaigns"
            value={count(snapshot, "paid_campaigns_total")}
            detail={`${count(snapshot, "fulfilled_campaigns_total")} fulfilled`}
          />
          <MetricCard
            label="Repeat businesses"
            value={count(snapshot, "repeat_businesses_total")}
            detail="Two or more verified paid campaigns"
          />
          <MetricCard
            label="Pending creator payout"
            value={money(count(snapshot, "pending_payout_cents"))}
            detail={`${money(count(snapshot, "released_payouts_total_cents"))} released all time`}
            tone={count(snapshot, "pending_payout_cents") ? "is-warm" : ""}
          />
          <MetricCard
            label="Ad credit outstanding"
            value={money(count(snapshot, "ad_credit_outstanding_cents"))}
            detail="Spend-only Business credit balance"
          />
          <MetricCard
            label="Payment issues"
            value={count(snapshot, "open_payment_issues")}
            detail={`${count(snapshot, "disputed_payments")} disputed payments`}
            tone={count(snapshot, "open_payment_issues") || count(snapshot, "disputed_payments") ? "is-alert" : ""}
          />
        </div>
      </section>

      <section className="founder-report-section" aria-labelledby="founder-activity-title">
        <div className="founder-section-head">
          <div>
            <p className="eyebrow">Last {periodDays} days</p>
            <h2 id="founder-activity-title">Funnel activity.</h2>
          </div>
          <p>Counts are events in the selected UTC window, not invented conversion rates.</p>
        </div>
        <div className="founder-metric-grid">
          <MetricCard
            label="Listing views"
            value={count(period, "listing_views")}
            detail={`${count(period, "unique_listing_viewers")} unique browsers`}
          />
          <MetricCard
            label="New members"
            value={count(period, "new_members")}
            detail={`${count(period, "onboarding_completed")} completed onboarding`}
          />
          <MetricCard
            label="Listings published"
            value={count(period, "listings_published")}
            detail="New or first reactivated inventory"
          />
          <MetricCard
            label="Requests sent"
            value={count(period, "requests_sent")}
            detail="Real member-to-member requests"
          />
          <MetricCard
            label="Campaigns accepted"
            value={count(period, "campaigns_accepted")}
            detail="Acceptance transitions recorded by Postgres"
          />
          <MetricCard
            label="Campaigns fulfilled"
            value={count(period, "campaigns_fulfilled")}
            detail={`${count(period, "paid_campaigns")} payments verified`}
          />
          <MetricCard
            label="Repeat businesses"
            value={count(period, "repeat_businesses")}
            detail="Two or more paid campaigns in this window"
          />
        </div>
      </section>

      <section className="founder-report-section" aria-labelledby="founder-money-title">
        <div className="founder-section-head">
          <div>
            <p className="eyebrow">Verified payments</p>
            <h2 id="founder-money-title">Money in motion.</h2>
          </div>
          <p>Gross figures are deliberately separated from tax, credits, and refunds.</p>
        </div>
        <div className="founder-money-grid">
          <MetricCard
            label="Verified GMV"
            value={money(count(period, "gmv_cents"))}
            detail="Original campaign subtotals"
          />
          <MetricCard
            label="Cash collected"
            value={money(count(period, "cash_collected_cents"))}
            detail="Stripe charge incl. tax, before refunds"
          />
          <MetricCard
            label="Platform gross fees"
            value={money(count(period, "platform_gross_revenue_cents"))}
            detail="Buyer fee plus Creator fee; before Stripe costs"
          />
          <MetricCard
            label="Refunded"
            value={money(count(period, "refunds_cents"))}
            detail="Succeeded Stripe refunds in the window"
          />
          <MetricCard
            label="Tax collected"
            value={money(count(period, "tax_collected_cents"))}
            detail="Not SideSpace revenue"
          />
          <MetricCard
            label="Ad credit applied"
            value={money(count(period, "ad_credits_applied_cents"))}
            detail="Non-cash promotion applied at checkout"
          />
          <MetricCard
            label="Payouts released"
            value={money(count(period, "payouts_released_cents"))}
            detail="Creator funds released in the window"
          />
          <MetricCard
            label="Payment failures"
            value={count(period, "payment_failures")}
            detail="Rows currently marked payment_failed"
            tone={count(period, "payment_failures") ? "is-alert" : ""}
          />
        </div>
      </section>

      <section className="founder-report-section founder-breakdown-section" aria-labelledby="founder-breakdowns-title">
        <div className="founder-section-head">
          <div>
            <p className="eyebrow">Composition</p>
            <h2 id="founder-breakdowns-title">Where the work is.</h2>
          </div>
          <p>Current real-member rows, useful for spotting supply or workflow bottlenecks.</p>
        </div>
        <div className="founder-breakdown-grid">
          <Breakdown title="Request status" values={requestStatuses} />
          <Breakdown title="Payment status" values={paymentStatuses} />
          <Breakdown title="Active listing channel" values={listingChannels} />
        </div>
      </section>

      <section className="founder-report-section" aria-labelledby="founder-daily-title">
        <div className="founder-section-head">
          <div>
            <p className="eyebrow">Daily trail</p>
            <h2 id="founder-daily-title">Recent activity, day by day.</h2>
          </div>
          <p>Showing the most recent 14 days inside the selected window.</p>
        </div>
        {daily.length ? (
          <div className="founder-table-wrap">
            <table className="founder-table">
              <thead>
                <tr>
                  <th scope="col">UTC day</th>
                  <th scope="col">Views</th>
                  <th scope="col">Members</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Paid</th>
                  <th scope="col">Fulfilled</th>
                  <th scope="col">GMV</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((row) => (
                  <tr key={row.date}>
                    <th scope="row">{row.date}</th>
                    <td>{row.listing_views}</td>
                    <td>{row.new_members}</td>
                    <td>{row.requests_sent}</td>
                    <td>{row.campaigns_accepted}</td>
                    <td>{row.paid_campaigns}</td>
                    <td>{row.campaigns_fulfilled}</td>
                    <td>{money(row.gmv_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="founder-empty">No activity in this window.</div>
        )}
      </section>

      <footer className="founder-report-footnote">
        <strong>Read the numbers with their definitions.</strong>
        <p>
          Historical current-state totals are complete. Legacy campaign rows do
          not retain a trustworthy acceptance timestamp, so the acceptance-event
          series starts at {dateLabel(String(tracking.acceptance_events_started_at ?? ""))};
          no historical acceptance date is guessed.
        </p>
      </footer>
    </main>
  );
}
