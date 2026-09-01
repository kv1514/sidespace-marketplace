import {
  ApiError,
  errorResponse,
  profileCanReceivePayouts,
  requireAuthenticatedProfile,
  requireSameOrigin,
  requireUuid,
} from "@/lib/payments/auth";
import { buildCheckoutSessionParams, getAppOrigin } from "@/lib/payments/checkout";
import {
  checkoutIdempotencyKey,
  checkoutSessionAction,
  shouldAdvanceCheckoutAttempt,
} from "@/lib/payments/checkout-state";
import { getStripeAccountReadiness } from "@/lib/payments/connect";
import {
  createTrustedPaymentSnapshot,
  type CampaignPaymentSource,
} from "@/lib/payments/marketplace";
import { getStripe, stripeKeyMode } from "@/lib/stripe/server";
import { requireStripeHostedUrl } from "@/lib/stripe/urls";
import { enforcePaymentRateLimit } from "@/lib/payments/rate-limit";

const transactionColumns =
  "id,status,checkout_attempt,stripe_checkout_session_id,currency,subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents,platform_gross_revenue_cents,stripe_connected_account_id,business_profile_id,creator_profile_id";

type TransactionRow = {
  id: string;
  status: string;
  checkout_attempt: number;
  stripe_checkout_session_id: string | null;
  currency: string;
  subtotal_cents: number;
  buyer_fee_cents: number;
  creator_fee_cents: number;
  customer_total_cents: number;
  creator_payout_cents: number;
  payout_amount_cents: number;
  platform_gross_revenue_cents: number;
  stripe_connected_account_id: string;
  business_profile_id: string;
  creator_profile_id: string;
};

function one<T>(value: T | T[]) {
  return Array.isArray(value) ? value[0] : value;
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (
      process.env.NODE_ENV === "production" &&
      process.env.PAYMENTS_CHECKOUT_ENABLED !== "true"
    ) {
      throw new ApiError("Payments are temporarily unavailable.", 503);
    }
    const origin = getAppOrigin(request.url);
    const body = (await request.json().catch(() => null)) as {
      campaignRequestId?: unknown;
    } | null;
    const campaignRequestId = requireUuid(
      body?.campaignRequestId,
      "Choose an accepted campaign to check out.",
    );

    const { user, profile, admin } = await requireAuthenticatedProfile();
    await enforcePaymentRateLimit(admin, {
      bucket: "stripe_checkout",
      profileId: profile.id,
      maxRequests: 8,
      windowSeconds: 10 * 60,
    });
    const { data: rawCampaign, error: campaignError } = await admin
      .from("campaign_requests")
      .select(
        "id,campaign_name,status,accepted_subtotal_cents,requester_profile_id,owner_profile_id,payer_profile_id,payee_profile_id,listing:listings!campaign_requests_listing_id_fkey(id,owner_profile_id,title,channel,provenance_status,availability_confirmed_at),requester:profiles!campaign_requests_requester_profile_id_fkey(id,display_name,role,extra_roles),owner:profiles!campaign_requests_owner_profile_id_fkey(id,display_name,role,extra_roles)",
      )
      .eq("id", campaignRequestId)
      .single();
    if (campaignError || !rawCampaign) {
      throw new ApiError("Campaign request not found.", 404);
    }

    const campaign = {
      ...rawCampaign,
      listing: one(rawCampaign.listing),
      requester: one(rawCampaign.requester),
      owner: one(rawCampaign.owner),
    } as unknown as CampaignPaymentSource;
    const listing = campaign.listing as CampaignPaymentSource["listing"] & {
      provenance_status?: string | null;
      availability_confirmed_at?: string | null;
    };
    const confirmedAt = Date.parse(listing.availability_confirmed_at ?? "");
    if (
      !["owner_attested", "staff_verified"].includes(
        listing.provenance_status ?? "unverified",
      ) ||
      !Number.isFinite(confirmedAt) ||
      Date.now() - confirmedAt > 90 * 24 * 60 * 60 * 1000
    ) {
      throw new ApiError(
        "The listing owner must confirm this inventory before it can be paid.",
        409,
      );
    }
    const snapshot = createTrustedPaymentSnapshot(campaign);
    if (snapshot.businessProfileId !== profile.id) {
      throw new ApiError("Only the business paying for this campaign can check out.", 403);
    }

    const creatorProfile =
      campaign.requester.id === snapshot.creatorProfileId
        ? campaign.requester
        : campaign.owner.id === snapshot.creatorProfileId
          ? campaign.owner
          : null;
    if (!creatorProfile || !profileCanReceivePayouts(creatorProfile)) {
      throw new ApiError(
        "The campaign payee must have a creator profile before checkout.",
        409,
      );
    }

    const { data: creatorAccount, error: accountError } = await admin
      .from("stripe_accounts")
      .select(
        "stripe_connected_account_id,charges_enabled,payouts_enabled,details_submitted,requirements_due",
      )
      .eq("profile_id", snapshot.creatorProfileId)
      .maybeSingle();
    if (accountError) throw accountError;
    if (
      !creatorAccount?.stripe_connected_account_id ||
      !getStripeAccountReadiness(creatorAccount).ready
    ) {
      throw new ApiError(
        "The creator must finish Stripe payout setup before this campaign can be paid.",
        409,
      );
    }

    const stripe = getStripe();
    const connected = await stripe.accounts.retrieve(
      creatorAccount.stripe_connected_account_id,
    );
    if (connected.deleted || !getStripeAccountReadiness(connected).ready) {
      throw new ApiError(
        "The creator's Stripe payout account needs attention before checkout.",
        409,
      );
    }

    const { data: payerAccount, error: payerAccountError } = await admin
      .from("stripe_accounts")
      .select("profile_id,stripe_customer_id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (payerAccountError) throw payerAccountError;
    let customerId = payerAccount?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email: profile.contact_email || user.email || undefined,
          name: profile.display_name,
          metadata: { sidespace_profile_id: profile.id },
        },
        { idempotencyKey: `sidespace-customer-${profile.id}` },
      );
      customerId = customer.id;
      const { error } = payerAccount
        ? await admin
            .from("stripe_accounts")
            .update({ stripe_customer_id: customerId })
            .eq("profile_id", profile.id)
        : await admin.from("stripe_accounts").insert({
            profile_id: profile.id,
            stripe_customer_id: customerId,
          });
      if (error) {
        if (error.code !== "23505") throw error;
        const raced = await admin
          .from("stripe_accounts")
          .select("stripe_customer_id")
          .eq("profile_id", profile.id)
          .single();
        if (raced.error || raced.data?.stripe_customer_id !== customerId) {
          throw error;
        }
      }
    }

    const initialTransaction = await admin
      .from("payment_transactions")
      .select(transactionColumns)
      .eq("campaign_request_id", campaign.id)
      .maybeSingle<TransactionRow>();
    if (initialTransaction.error) throw initialTransaction.error;
    let transaction = initialTransaction.data;

    if (!transaction) {
      const inserted = await admin
        .from("payment_transactions")
        .insert({
          campaign_request_id: snapshot.campaignRequestId,
          listing_id: snapshot.listingId,
          business_profile_id: snapshot.businessProfileId,
          creator_profile_id: snapshot.creatorProfileId,
          campaign_name: snapshot.campaignName,
          listing_title: snapshot.listingTitle,
          business_name: snapshot.businessName,
          creator_name: snapshot.creatorName,
          subtotal_cents: snapshot.subtotalCents,
          buyer_fee_cents: snapshot.buyerFeeCents,
          creator_fee_cents: snapshot.creatorFeeCents,
          customer_total_cents: snapshot.customerTotalCents,
          creator_payout_cents: snapshot.creatorPayoutCents,
          // NOT NULL with no default, and the amount actually transferred on
          // release - creator_payout_cents is the ceiling a refund adjusts
          // down from, which is what the 20260830120000 backfill seeded it to.
          payout_amount_cents: snapshot.creatorPayoutCents,
          platform_gross_revenue_cents: snapshot.platformGrossRevenueCents,
          stripe_connected_account_id: creatorAccount.stripe_connected_account_id,
          stripe_customer_id: customerId,
        })
        .select(transactionColumns)
        .single<TransactionRow>();
      if (inserted.error) {
        if (inserted.error.code !== "23505") throw inserted.error;
        const raced = await admin
          .from("payment_transactions")
          .select(transactionColumns)
          .eq("campaign_request_id", campaign.id)
          .single<TransactionRow>();
        if (raced.error || !raced.data) throw inserted.error;
        transaction = raced.data;
      } else {
        transaction = inserted.data;
      }
    }

    if (!transaction) throw new Error("Payment transaction was not created.");
    if (
      transaction.subtotal_cents !== snapshot.subtotalCents ||
      transaction.currency !== "usd" ||
      transaction.buyer_fee_cents !== snapshot.buyerFeeCents ||
      transaction.creator_fee_cents !== snapshot.creatorFeeCents ||
      transaction.customer_total_cents !== snapshot.customerTotalCents ||
      transaction.creator_payout_cents !== snapshot.creatorPayoutCents ||
      transaction.payout_amount_cents !== snapshot.creatorPayoutCents ||
      transaction.platform_gross_revenue_cents !==
        snapshot.platformGrossRevenueCents ||
      transaction.stripe_connected_account_id !==
        creatorAccount.stripe_connected_account_id ||
      transaction.business_profile_id !== snapshot.businessProfileId ||
      transaction.creator_profile_id !== snapshot.creatorProfileId
    ) {
      throw new ApiError("The stored payment terms do not match this campaign.", 409);
    }
    if (
      ["paid", "partially_refunded", "refunded", "disputed"].includes(
        transaction.status,
      )
    ) {
      throw new ApiError("This campaign already has a completed payment.", 409);
    }

    if (transaction.stripe_checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(
        transaction.stripe_checkout_session_id,
      );
      const action = checkoutSessionAction(existing.status);
      if (action === "reuse") {
        return Response.json({
          url: requireStripeHostedUrl(existing.url, ["checkout.stripe.com"]),
          reused: true,
        });
      }
      if (action === "wait_for_webhook") {
        throw new ApiError(
          "This checkout has completed and its payment is still being verified.",
          409,
        );
      }

      const nextAttempt = transaction.checkout_attempt + 1;
      const advanced = await admin
        .from("payment_transactions")
        .update({
          checkout_attempt: nextAttempt,
          stripe_checkout_session_id: null,
          checkout_expires_at: null,
          status: "requires_checkout",
          workflow_status: "requires_checkout",
        })
        .eq("id", transaction.id)
        .eq("checkout_attempt", transaction.checkout_attempt)
        .select(transactionColumns)
        .maybeSingle<TransactionRow>();
      if (advanced.error) throw advanced.error;
      if (advanced.data) {
        transaction = advanced.data;
      } else {
        const reloaded = await admin
          .from("payment_transactions")
          .select(transactionColumns)
          .eq("id", transaction.id)
          .single<TransactionRow>();
        if (reloaded.error || !reloaded.data) throw reloaded.error;
        transaction = reloaded.data;
        if (transaction.stripe_checkout_session_id) {
          const concurrent = await stripe.checkout.sessions.retrieve(
            transaction.stripe_checkout_session_id,
          );
          if (checkoutSessionAction(concurrent.status) === "reuse") {
            return Response.json({
              url: requireStripeHostedUrl(concurrent.url, ["checkout.stripe.com"]),
              reused: true,
            });
          }
          throw new ApiError(
            "Checkout state changed. Refresh before trying again.",
            409,
          );
        }
      }
    }

    const checkoutSnapshot = {
      transactionId: transaction.id,
      campaignRequestId: snapshot.campaignRequestId,
      campaignName: snapshot.campaignName,
      listingTitle: snapshot.listingTitle,
      creatorProfileId: snapshot.creatorProfileId,
      customerId,
      subtotalCents: snapshot.subtotalCents,
      buyerFeeCents: snapshot.buyerFeeCents,
      creatorFeeCents: snapshot.creatorFeeCents,
      customerTotalCents: snapshot.customerTotalCents,
      creatorPayoutCents: snapshot.creatorPayoutCents,
      platformGrossRevenueCents: snapshot.platformGrossRevenueCents,
    };
    const params = buildCheckoutSessionParams(
      checkoutSnapshot,
      origin,
    );
    let session;
    try {
      session = await stripe.checkout.sessions.create(params, {
        idempotencyKey: checkoutIdempotencyKey(
          transaction.id,
          transaction.checkout_attempt,
        ),
      });
    } catch (error) {
      if (shouldAdvanceCheckoutAttempt(error)) {
        const { error: advanceError } = await admin
          .from("payment_transactions")
          .update({ checkout_attempt: transaction.checkout_attempt + 1 })
          .eq("id", transaction.id)
          .eq("checkout_attempt", transaction.checkout_attempt)
          .eq("status", "requires_checkout");
        if (advanceError) throw advanceError;
      }
      throw error;
    }
    if (session.livemode !== (stripeKeyMode() === "live")) {
      throw new Error("Checkout Session mode does not match the configured API keys.");
    }
    const checkoutUrl = requireStripeHostedUrl(session.url, [
      "checkout.stripe.com",
    ]);

    const { data: updatedTransaction, error: updateError } = await admin
      .from("payment_transactions")
      .update({
        status: "checkout_open",
        workflow_status: "checkout_open",
        stripe_checkout_session_id: session.id,
        checkout_expires_at: session.expires_at
          ? new Date(session.expires_at * 1000).toISOString()
          : null,
      })
      .eq("id", transaction.id)
      .eq("checkout_attempt", transaction.checkout_attempt)
      .in("status", ["requires_checkout", "checkout_open"])
      .select(transactionColumns)
      .maybeSingle<TransactionRow>();
    if (updateError) throw updateError;
    if (!updatedTransaction) {
      throw new ApiError("Checkout state changed. Refresh before trying again.", 409);
    }

    return Response.json({ url: checkoutUrl, reused: false });
  } catch (error) {
    return errorResponse(error);
  }
}

export const runtime = "nodejs";
