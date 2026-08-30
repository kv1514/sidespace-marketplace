import { releasePendingPayout } from "@/lib/payments/release";
import { createAdminClient } from "@/lib/supabase/admin";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Cron authorization is required." }, { status: 401 });
  }
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("payment_transactions")
    .select("id")
    .in("payout_status", ["pending", "releasing"])
    .eq("issue_status", "none")
    .eq("workflow_status", "awaiting_payer_review")
    .lte("review_deadline", now)
    .order("review_deadline", { ascending: true })
    .limit(50);
  if (error) throw error;

  const results = await Promise.allSettled(
    (data ?? []).map((transaction) =>
      releasePendingPayout(admin, {
        transactionId: transaction.id,
        mode: "automatic",
      }),
    ),
  );
  const failed = results
    .map((result, index) => ({ result, transactionId: data?.[index]?.id }))
    .filter(
      (item): item is {
        result: PromiseRejectedResult;
        transactionId: string;
      } => item.result.status === "rejected" && Boolean(item.transactionId),
    )
    .map((item) => ({
      transactionId: item.transactionId,
      error:
        item.result.reason instanceof Error
          ? item.result.reason.message
          : "Payout release failed.",
    }));
  return Response.json(
    { checked: data?.length ?? 0, released: results.length - failed.length, failed },
    { status: failed.length ? 500 : 200 },
  );
}

export const runtime = "nodejs";

