"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./account-balance.css";
import type { AccountBalance as Balance } from "@/lib/payments/balance";
import { isBusinessReferralCode, normalizeBusinessReferralCode } from "@/lib/payments/ad-credits";
import { useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n";

// Stripe balances can be negative. The checkout formatter deliberately rejects
// negative prices, so use a signed formatter for this read-only money view.
const money = (cents: number, currency = "usd") => new Intl.NumberFormat("en-US", {
  style: "currency", currency: currency.toUpperCase(),
}).format(cents / 100);
const activityLabels: Record<string, string> = {
  signup_grant: msg("Referral credit"), admin_grant: msg("SideSpace promo credit"),
  checkout_reserve: msg("Reserved for checkout"), checkout_release: msg("Checkout credit returned"),
  refund_restore: msg("Refund credit returned"),
};

export function AccountBalance({ profileId, canEarn, canRedeem, stripeConfigured, busy, onStripe, onRedeem, onCreditsChange, renderDialog }: {
  profileId: string; canEarn: boolean; canRedeem: boolean; stripeConfigured: boolean; busy: boolean;
  onStripe: (path: string) => void;
  onRedeem: (code: string) => Promise<number>;
  onCreditsChange: (cents: number) => void;
  renderDialog: (content: ReactNode, close: () => void) => ReactNode;
}) {
  const t = useT();
  const [data, setData] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    return fetch("/api/payments/balance", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("We couldn’t load your balance. Please try again.");
        return await response.json() as Balance;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setError(""); setData(result);
        if (result.promo) onCreditsChange(result.promo.balanceCents);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(t(error instanceof Error ? error.message : "We couldn’t load your balance."));
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [onCreditsChange, t]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { setLoading(true); void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { requestRef.current?.abort(); window.removeEventListener("focus", onFocus); };
  }, [profileId, refresh]);

  const stripe = data?.stripe;
  const available = stripe?.status === "connected" ? stripe.balances : [];
  const balanceLabel = loading ? t("Loading…") : canEarn
    ? stripe?.status === "connected" ? available.length ? available.map((entry) => money(entry.availableCents, entry.currency)).join(" · ") : money(0)
      : stripe?.status === "not_connected" ? t("Start earning") : t("View balance")
    : data?.promo ? money(data.promo.balanceCents) : t("View balance");
  const content = <div className="balance-detail">
    <header className="balance-heading"><p className="eyebrow">{t("Your SideSpace")}</p><h2>{t("Balance")}</h2><p>{t("A little space. Real earnings.")}</p></header>
    {data?.livemode === false && <p className="balance-notice">{t("Test mode · These are sandbox balances.")}</p>}
    <div className="balance-refresh"><span role="status">{loading ? t("Updating your balance…") : t("Refresh for the latest amounts")}</span><button type="button" disabled={loading} onClick={() => { setLoading(true); void refresh(); }}>{t("Refresh ↻")}</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {canEarn && <>
      <section className="balance-earned" aria-label={t("SideSpace earnings")}>
        <p className="eyebrow">{t("Total earned on SideSpace")}</p>
        {data?.earnings ? (data.earnings.length ? data.earnings : [{ currency: "usd", earnedCents: 0, pendingCents: 0 }]).map((entry) => <div key={entry.currency}><strong>{money(entry.earnedCents, entry.currency)}</strong><p>{t("{pendingCents} awaiting campaign completion or review", { pendingCents: money(entry.pendingCents, entry.currency) })}</p></div>) : <p>{loading ? t("Loading earnings…") : t("Earnings are temporarily unavailable.")}</p>}
        <small>{t("Net campaign payouts sent to Stripe, including money already paid to your bank. Adjusted for refunds and reversals.")}</small>
      </section>
      <section className="balance-section" aria-label={t("Stripe balance")}>
        <div className="balance-section-title"><h3>{t("Stripe balance")}</h3><span className="balance-badge">{stripe?.status === "connected" ? t("Connected") : t("Payouts")}</span></div>
        {stripe?.status === "connected" ? <>
          {(available.length ? available : [{ currency: "usd", availableCents: 0, pendingCents: 0 }]).map((entry) => <dl className="balance-amounts" key={entry.currency}><div><dt>{t("Available in Stripe")}{available.length > 1 ? ` · ${entry.currency.toUpperCase()}` : ""}</dt><dd>{money(entry.availableCents, entry.currency)}</dd></div><div><dt>{t("Pending in Stripe")}</dt><dd>{money(entry.pendingCents, entry.currency)}</dd></div></dl>)}
          <p>{stripe.payoutsEnabled ? t("Available funds follow your Stripe payout schedule. Pending funds are still settling.") : t("Complete your Stripe requirements to receive bank payouts.")}</p>
        </> : <p>{loading ? t("Loading Stripe balance…") : stripe?.status === "not_connected" ? t("Connect Stripe to receive your SideSpace earnings.") : t("We couldn’t reach your Stripe balance. Refresh to try again.")}</p>}
        {stripeConfigured && stripe?.status !== "unavailable" && stripe && <button className="button button-dark button-small" disabled={busy} onClick={() => onStripe(stripe.status === "connected" && stripe.payoutsEnabled ? "/api/stripe/connect/login" : "/api/stripe/connect/onboard")}>
          {stripe.status === "connected" ? stripe.payoutsEnabled ? t("Manage payouts in Stripe ↗") : t("Continue Stripe setup ↗") : t("Set up Stripe payouts ↗")}
        </button>}
      </section>
    </>}
    <section className="balance-section balance-promo" aria-label={t("Promotional credits")}>
      <div className="balance-section-title"><h3>{t("Promo credits")}</h3><span className="balance-badge">{t("For campaigns")}</span></div>
      <strong className="balance-promo-amount">{data?.promo ? money(data.promo.balanceCents) : loading ? t("Loading…") : t("Unavailable")}</strong>
      <p>{canRedeem ? t("Referral rewards and SideSpace promotions apply automatically at checkout. SideSpace covers the credit; your creator’s payout stays the same.") : t("Promotional campaign credits are available to Business accounts.")}</p>
      <small>{t("Promo credits cannot be withdrawn or transferred.")}</small>
      {canRedeem && <form className="balance-code-form" onSubmit={async (event) => {
        event.preventDefault();
        const normalized = normalizeBusinessReferralCode(code);
        if (!isBusinessReferralCode(normalized)) { setNotice("Enter a valid referral code."); return; }
        setRedeeming(true); setNotice("");
        try {
          const awarded = await onRedeem(normalized);
          setNotice(awarded > 0 ? `${money(awarded)} added to your promo credits.` : "This code is unavailable, or you’ve already redeemed your referral reward.");
          if (awarded > 0) setCode("");
          await refresh();
        } catch { setNotice("We couldn’t apply that code. Please try again."); }
        finally { setRedeeming(false); }
      }}><label htmlFor="balance-referral-code">{t("Have a referral code?")}</label><div><input id="balance-referral-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("Enter code")} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={redeeming} /><button className="button button-dark button-small" disabled={redeeming || !code.trim()}>{redeeming ? t("Applying…") : t("Apply code")}</button></div><small>{t("One referral reward per email.")}</small>{notice && <p role="status">{notice}</p>}</form>}
      {!!data?.promo?.activity.length && <div className="balance-activity"><h4>{t("Recent credit activity")}</h4><ul>{data.promo.activity.map((entry) => <li key={entry.id}><div><span>{t(activityLabels[entry.type] ?? "Promo adjustment")}</span><small>{new Date(entry.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></div><b>{entry.amountCents > 0 ? "+" : ""}{money(entry.amountCents)}</b></li>)}</ul></div>}
    </section>
  </div>;
  return <>
    <button type="button" className="dashboard-panel balance-card" id="balance" aria-haspopup="dialog" onClick={() => { setOpen(true); setLoading(true); void refresh(); }}>
      <span className="balance-card-copy"><span className="eyebrow">{t("Balance")}</span><strong>{balanceLabel}</strong><span>{canEarn ? t("Your Stripe balance, earnings & promo credits") : t("Promo credits for your next campaign")}</span></span>
      <span className="balance-card-action">{t("View balance")}{" "}<span aria-hidden="true">↗</span></span>
    </button>
    {open && renderDialog(content, () => setOpen(false))}
  </>;
}
