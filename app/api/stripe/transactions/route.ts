import { errorResponse, requireAuthenticatedProfile } from "@/lib/payments/auth";

export async function GET() {
  try {
    const { profile, admin } = await requireAuthenticatedProfile();
    const { data, error } = await admin
      .from("payment_transactions")
      .select(
        "id,campaign_request_id,listing_id,business_profile_id,creator_profile_id,campaign_name,listing_title,business_name,creator_name,currency,subtotal_cents,buyer_fee_cents,creator_fee_cents,customer_total_cents,creator_payout_cents,payout_amount_cents,platform_gross_revenue_cents,tax_cents,refunded_cents,status,workflow_status,payout_status,delivered_at,review_deadline,confirmed_at,issue_reported_at,issue_status,escalated_at,payout_released_at,payout_last_error,dispute_status,paid_at,created_at,updated_at,issue:payment_issues(id,details,status,reported_at,resolution_attempted_at,escalated_at,resolved_at,resolution_action),review:creator_reviews(id,payment_transaction_id,payer_profile_id,creator_profile_id,rating,review_text,created_at)",
      )
      .or(
        `business_profile_id.eq.${profile.id},creator_profile_id.eq.${profile.id}`,
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    const transactions = (data ?? []).map(({ payout_last_error, ...transaction }) => ({
      ...transaction,
      // Keep provider/internal failure text server-side while still allowing
      // participants to see that a payout needs attention.
      payout_issue: Boolean(payout_last_error),
    }));
    return Response.json(
      { transactions },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
