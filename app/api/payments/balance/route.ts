import { errorResponse, profileCanReceivePayouts, requireAuthenticatedProfile } from "@/lib/payments/auth";
import { readBalancePages, readPromoBalance } from "@/lib/payments/balance-server";
import { summarizeEarnings, summarizeStripeBalance, type AccountBalance } from "@/lib/payments/balance";
import { getStripe, stripeKeyMode } from "@/lib/stripe/server";

export async function GET() {
  try {
    const { profile, admin } = await requireAuthenticatedProfile();
    const result: AccountBalance = {
      livemode: null, promo: null, earnings: null,
      stripe: { status: profileCanReceivePayouts(profile) ? "unavailable" : "not_eligible", payoutsEnabled: false, balances: [] },
    };
    // A provider outage must not hide promotional credit (or imply a zero balance).
    try { result.promo = await readPromoBalance(admin, profile); }
    catch (error) { console.error("Could not read promotional balance", error); }

    if (profileCanReceivePayouts(profile)) {
      try {
        result.livemode = stripeKeyMode() === "live";
        const { data: saved, error } = await admin.from("stripe_accounts")
          .select("stripe_connected_account_id")
          .eq("profile_id", profile.id).eq("livemode", result.livemode).maybeSingle();
        if (error) throw error;
        const accountId = saved?.stripe_connected_account_id;
        if (!accountId) {
          result.stripe.status = "not_connected";
          result.earnings = [];
        } else {
          // Transactions predate a livemode column. Scope to the saved account
          // for this mode as well as the authenticated creator, never client IDs.
          try {
            const rows = await readBalancePages((from, to) => admin.from("payment_transactions")
              .select("currency,paid_at,status,payout_status,payout_amount_cents,payout_recovery_target_cents,payout_recovery_reversed_cents", { count: "exact" })
              .eq("creator_profile_id", profile.id).eq("stripe_connected_account_id", accountId)
              .order("id").range(from, to));
            result.earnings = summarizeEarnings(rows);
          } catch (error) { console.error("Could not read SideSpace earnings", error); }
          const stripe = getStripe();
          const account = await stripe.accounts.retrieve(accountId);
          if (account.deleted) {
            result.stripe.status = "not_connected";
          } else {
            const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
            if (balance.livemode !== result.livemode) throw new Error("Stripe balance mode mismatch.");
            result.stripe = { status: "connected", payoutsEnabled: account.payouts_enabled, balances: summarizeStripeBalance(balance) };
          }
        }
      } catch (error) { console.error("Could not read Stripe balance", error); }
    } else {
      result.earnings = [];
    }
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export const runtime = "nodejs";
