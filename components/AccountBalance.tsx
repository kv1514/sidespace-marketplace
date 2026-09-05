"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./account-balance.css";
import type { AccountBalance as Balance } from "@/lib/payments/balance";
import { isBusinessReferralCode, normalizeBusinessReferralCode } from "@/lib/payments/ad-credits";
import { useLocale } from "@/app/components/LocaleProvider";

// Stripe balances can be negative. The checkout formatter deliberately rejects
// negative prices, so use a signed formatter for this read-only money view.
const money = (cents: number, currency = "usd") => new Intl.NumberFormat("en-US", {
  style: "currency", currency: currency.toUpperCase(),
}).format(cents / 100);
const activityLabels: Record<string, string> = {
  signup_grant: "Referral credit", admin_grant: "SideSpace promo credit",
  checkout_reserve: "Reserved for checkout", checkout_release: "Checkout credit returned",
  refund_restore: "Refund credit returned",
};

export function AccountBalance({ profileId, canEarn, canRedeem, stripeConfigured, busy, onStripe, onRedeem, onCreditsChange, renderDialog }: {
  profileId: string; canEarn: boolean; canRedeem: boolean; stripeConfigured: boolean; busy: boolean;
  onStripe: (path: string) => void;
  onRedeem: (code: string) => Promise<number>;
  onCreditsChange: (cents: number) => void;
  renderDialog: (content: ReactNode, close: () => void) => ReactNode;
}) {
  const { t } = useLocale();
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
          setError(error instanceof Error ? error.message : "We couldn’t load your balance.");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [onCreditsChange]);
  useEffect(() => {
    void refresh();
    const onFocus = () => { setLoading(true); void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { requestRef.current?.abort(); window.removeEventListener("focus", onFocus); };
  }, [profileId, refresh]);

  const stripe = data?.stripe;
  const available = stripe?.status === "connected" ? stripe.balances : [];
  const balanceLabel = loading ? "Loading…" : canEarn
    ? stripe?.status === "connected" ? available.length ? available.map((entry) => money(entry.availableCents, entry.currency)).join(" · ") : money(0)
      : stripe?.status === "not_connected" ? "Start earning" : "View balance"
    : data?.promo ? money(data.promo.balanceCents) : "View balance";
  const content = <div className="balance-detail">
    <header className="balance-heading"><p className="eyebrow">{t("balance.yourSidespace")}</p><h2>{t("balance.balance")}</h2><p>{t("balance.aLittleSpaceRealEarnings")}</p></header>
    {data?.livemode === false && <p className="balance-notice">{t("balance.testModeTheseAreSandboxBalances")}</p>}
    <div className="balance-refresh"><span role="status">{loading ? t("balance.updatingYourBalance") : t("balance.refreshForTheLatestAmounts")}</span><button type="button" disabled={loading} onClick={() => { setLoading(true); void refresh(); }}>{t("balance.refresh")}</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {canEarn && <>
      <section className="balance-earned" aria-label={t("balance.sidespaceEarnings")}>
        <p className="eyebrow">{t("balance.totalEarnedOnSidespace")}</p>
        {data?.earnings ? (data.earnings.length ? data.earnings : [{ currency: "usd", earnedCents: 0, pendingCents: 0 }]).map((entry) => <div key={entry.currency}><strong>{money(entry.earnedCents, entry.currency)}</strong><p>{t("balance.pendingcentsAwaitingCampaignCompletionOrReview", { pendingCents: money(entry.pendingCents, entry.currency) })}</p></div>) : <p>{loading ? t("balance.loadingEarnings") : t("balance.earningsAreTemporarilyUnavailable")}</p>}
        <small>{t("balance.netCampaignPayoutsSentToStripeIncluding")}</small>
      </section>
      <section className="balance-section" aria-label={t("balance.stripeBalance")}>
        <div className="balance-section-title"><h3>{t("balance.stripeBalance")}</h3><span className="balance-badge">{stripe?.status === "connected" ? t("balance.connected") : t("app.payouts")}</span></div>
        {stripe?.status === "connected" ? <>
          {(available.length ? available : [{ currency: "usd", availableCents: 0, pendingCents: 0 }]).map((entry) => <dl className="balance-amounts" key={entry.currency}><div><dt>{t("balance.availableInStripe")}{available.length > 1 ? ` · ${entry.currency.toUpperCase()}` : ""}</dt><dd>{money(entry.availableCents, entry.currency)}</dd></div><div><dt>{t("balance.pendingInStripe")}</dt><dd>{money(entry.pendingCents, entry.currency)}</dd></div></dl>)}
          <p>{stripe.payoutsEnabled ? t("balance.availableFundsFollowYourStripePayoutSchedule") : t("balance.completeYourStripeRequirementsToReceiveBank")}</p>
        </> : <p>{loading ? t("balance.loadingStripeBalance") : stripe?.status === "not_connected" ? t("balance.connectStripeToReceiveYourSidespaceEarnings") : t("balance.weCouldntReachYourStripeBalanceRefresh")}</p>}
        {stripeConfigured && stripe?.status !== "unavailable" && stripe && <button className="button button-dark button-small" disabled={busy} onClick={() => onStripe(stripe.status === "connected" && stripe.payoutsEnabled ? "/api/stripe/connect/login" : "/api/stripe/connect/onboard")}>
          {stripe.status === "connected" ? stripe.payoutsEnabled ? t("balance.managePayoutsInStripe") : t("balance.continueStripeSetup") : t("balance.setUpStripePayouts")}
        </button>}
      </section>
    </>}
    <section className="balance-section balance-promo" aria-label={t("balance.promotionalCredits")}>
      <div className="balance-section-title"><h3>{t("balance.promoCredits")}</h3><span className="balance-badge">{t("balance.forCampaigns")}</span></div>
      <strong className="balance-promo-amount">{data?.promo ? money(data.promo.balanceCents) : loading ? t("balance.loading") : t("balance.unavailable")}</strong>
      <p>{canRedeem ? t("balance.referralRewardsAndSidespacePromotionsApplyAutomatically") : t("balance.promotionalCampaignCreditsAreAvailableToBusiness")}</p>
      <small>{t("balance.promoCreditsCannotBeWithdrawnOrTransferred")}</small>
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
      }}><label htmlFor="balance-referral-code">{t("balance.haveAReferralCode")}</label><div><input id="balance-referral-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("balance.enterCode")} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={redeeming} /><button className="button button-dark button-small" disabled={redeeming || !code.trim()}>{redeeming ? t("balance.applying") : t("balance.applyCode")}</button></div><small>{t("balance.oneReferralRewardPerEmail")}</small>{notice && <p role="status">{notice}</p>}</form>}
      {!!data?.promo?.activity.length && <div className="balance-activity"><h4>{t("balance.recentCreditActivity")}</h4><ul>{data.promo.activity.map((entry) => <li key={entry.id}><div><span>{activityLabels[entry.type] ?? t("balance.promoAdjustment")}</span><small>{new Date(entry.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></div><b>{entry.amountCents > 0 ? "+" : ""}{money(entry.amountCents)}</b></li>)}</ul></div>}
    </section>
  </div>;
  return <>
    <button type="button" className="dashboard-panel balance-card" id="balance" aria-haspopup="dialog" onClick={() => { setOpen(true); setLoading(true); void refresh(); }}>
      <span className="balance-card-copy"><span className="eyebrow">{t("balance.balance")}</span><strong>{balanceLabel}</strong><span>{canEarn ? t("balance.yourStripeBalanceEarningsPromoCredits") : t("balance.promoCreditsForYourNextCampaign")}</span></span>
      <span className="balance-card-action">{t("balance.viewBalance")}{" "}<span aria-hidden="true">↗</span></span>
    </button>
    {open && renderDialog(content, () => setOpen(false))}
  </>;
}
