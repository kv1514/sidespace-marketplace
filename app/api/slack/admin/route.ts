import { randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/server";
import {
  parseSlackAdminCommand,
  slackActionKey,
  SlackCommandError,
  verifySlackSignature,
} from "@/lib/slack/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

const HELP = [
  "*SideSpace founder commands*",
  "`/sidespace user person@example.com` — account, listings, campaigns, credits, and payout ledger totals",
  "`/sidespace credit person@example.com 25 Launch recovery` — grant $25 in non-withdrawable ad credit",
  "`/sidespace referral 10` — create a new one-time-per-email $10 referral link",
  "`/sidespace suspend person@example.com Obscene listings` — hide their profile and listings, and stop them posting",
  "`/sidespace restore person@example.com` — lift a suspension",
  '`/sidespace block "jerkspace" Banned brand` — refuse that pattern in any listing title or description',
  '`/sidespace unblock "jerkspace"` — remove a blocked pattern',
  "`/sidespace blocklist` — show every blocked pattern",
  "All replies are ephemeral. Every change is audit-logged and safe to retry.",
].join("\n");

function slackReply(text: string, status = 200) {
  return Response.json(
    { response_type: "ephemeral", text },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function safeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function escapeSlack(value: unknown) {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function money(cents: unknown) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(safeNumber(cents) / 100);
}

function statusCounts(value: unknown) {
  const counts = asRecord(value);
  const entries = Object.entries(counts)
    .filter(([, count]) => safeNumber(count) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length
    ? entries.map(([status, count]) => `${escapeSlack(status)} ${safeNumber(count)}`).join(", ")
    : "none";
}

function formatUserSummary(summaryValue: unknown, stripeBalanceValue?: unknown) {
  const summary = asRecord(summaryValue);
  if (!summary.found) return "No SideSpace account was found for that authenticated email.";

  const account = asRecord(summary.account);
  const profile = asRecord(summary.profile);
  if (!profile.id) {
    return [
      `*Account:* ${escapeSlack(account.email)}`,
      "Supabase Auth exists, but this account has no SideSpace profile yet.",
    ].join("\n");
  }

  const credits = asRecord(summary.ad_credits);
  const creator = asRecord(summary.creator_payouts);
  const buyer = asRecord(summary.business_payments);
  const campaigns = asRecord(summary.campaigns);
  const connect = asRecord(summary.stripe_connect);
  const stripeBalance = asRecord(stripeBalanceValue);
  const listings = asRecords(summary.listings);
  const listingCount = safeNumber(summary.listing_count);
  const listingLines = listings.slice(0, 10).map((listing) =>
    `• ${escapeSlack(listing.title)} — ${escapeSlack(listing.status)} — ${money(listing.price_cents)}/${escapeSlack(listing.price_unit)}`,
  );

  return [
    `*${escapeSlack(profile.display_name) || "Unnamed member"}* — ${escapeSlack(account.email)}`,
    `Role: ${escapeSlack(profile.role)}${profile.onboarding_complete ? " · onboarding complete" : " · onboarding incomplete"}${profile.verified ? " · verified" : ""}`,
    `Ad credit available: *${money(credits.balance_cents)}* (SideSpace spend-only credit)`,
    `Creator payout ledger: ${money(creator.released_cents)} released · ${money(creator.pending_cents)} pending · ${money(creator.blocked_cents)} blocked`,
    `Business payment ledger: ${money(buyer.charged_cents)} charged · ${money(buyer.refunded_cents)} refunded`,
    `Campaigns as buyer: ${statusCounts(campaigns.as_buyer)} · as creator: ${statusCounts(campaigns.as_creator)}`,
    `Stripe Connect: ${connect.configured ? `${connect.charges_enabled ? "charges on" : "charges off"}, ${connect.payouts_enabled ? "payouts on" : "payouts off"}` : "not configured"}`,
    ...(connect.configured
      ? [
          `Live connected Stripe balance: ${stripeBalance.available_cents === undefined ? "unavailable" : `${money(stripeBalance.available_cents)} available · ${money(stripeBalance.pending_cents)} pending`}`,
        ]
      : []),
    `Listings: *${listingCount}*${listingLines.length ? `\n${listingLines.join("\n")}` : ""}${listingCount > listingLines.length ? `\n…and ${listingCount - listingLines.length} more.` : ""}`,
    "_SideSpace ledger figures and the live connected Stripe balance are labeled separately._",
  ].join("\n");
}

async function loadConnectedStripeBalance(summaryValue: unknown) {
  const connect = asRecord(asRecord(summaryValue).stripe_connect);
  const accountId = safeText(connect.account_id);
  if (!accountId) return null;
  try {
    const balance = await getStripe().balance.retrieve(
      {},
      { stripeAccount: accountId, maxNetworkRetries: 0, timeout: 1_200 },
    );
    const usd = (amounts: Array<{ amount: number; currency: string }>) =>
      amounts
        .filter((entry) => entry.currency === "usd")
        .reduce((total, entry) => total + entry.amount, 0);
    return {
      available_cents: usd(balance.available),
      pending_cents: usd(balance.pending),
    };
  } catch (error) {
    console.error("Slack admin Stripe balance lookup failed", {
      code: safeText(asRecord(error).code) || "unavailable",
    });
    return null;
  }
}

function safeRpcMessage(error: unknown) {
  const message = safeText(asRecord(error).message);
  const allowed = [
    "No SideSpace profile exists for that authenticated email.",
    "Advertising credits can only be granted to a Business profile.",
    "The Slack action key was already used for another operation.",
    "Internal SideSpace accounts cannot be suspended.",
    "A blocklist pattern must be 4 to 200 characters, with a reason.",
    "That is not a valid search pattern.",
    "That pattern matches every listing. Use something more specific.",
  ];
  if (allowed.includes(message)) return message;
  // The collateral-damage refusal names the listings it would have blocked, so
  // it cannot be matched exactly. It is safe to surface: titles are already
  // public, and the whole point is that the founder sees what they nearly hit.
  return message.startsWith("That pattern would block ") ? message : null;
}

function referralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `SS-${suffix}`;
}

function referralUrl(code: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL || "https://sidespace.ad";
  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("The SideSpace app URL must use HTTPS in production.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("ref", code);
  return url.toString();
}

async function runCommand(input: {
  text: string;
  actionKey: string;
  slackUserId: string;
}) {
  const command = parseSlackAdminCommand(input.text);
  if (command.type === "help") return HELP;

  const admin = createAdminClient();
  if (command.type === "user") {
    const { data, error } = await admin.rpc("get_sidespace_admin_user_summary", {
      target_email: command.email,
    });
    if (error) throw error;
    return formatUserSummary(data, await loadConnectedStripeBalance(data));
  }

  if (command.type === "credit") {
    const { data, error } = await admin.rpc("grant_business_ad_credit_by_email", {
      target_email: command.email,
      grant_cents: command.amountCents,
      grant_reason: command.reason,
      admin_action_key: input.actionKey,
      slack_user_id: input.slackUserId,
    });
    if (error) {
      const message = safeRpcMessage(error);
      if (message) throw new SlackCommandError(message);
      throw error;
    }
    const result = asRecord(data);
    return [
      `Granted *${money(result.awarded_cents)}* in SideSpace ad credit to ${escapeSlack(result.email)}.`,
      `New available balance: *${money(result.balance_cents)}*`,
      `_Reason: ${escapeSlack(command.reason)} · audit ID ${input.actionKey.slice(0, 12)}_`,
    ].join("\n");
  }

  if (command.type === "suspend" || command.type === "restore") {
    const suspend = command.type === "suspend";
    const { data, error } = await admin.rpc("set_member_suspension_by_email", {
      target_email: command.email,
      suspend,
      suspend_reason: suspend ? command.reason : null,
      admin_action_key: input.actionKey,
      slack_user_id: input.slackUserId,
    });
    if (error) {
      const message = safeRpcMessage(error);
      if (message) throw new SlackCommandError(message);
      throw error;
    }
    const result = asRecord(data);
    const who = `*${escapeSlack(result.display_name) || "Unnamed member"}* (${escapeSlack(result.email)})`;
    return suspend
      ? [
          `Suspended ${who}.`,
          `Their profile and *${safeNumber(result.affected_listings)}* active listing(s) are hidden, and they cannot publish again.`,
          `_Reason: ${escapeSlack(command.reason)} · audit ID ${input.actionKey.slice(0, 12)}_`,
        ].join("\n")
      : [
          `Restored ${who}.`,
          `Their profile and *${safeNumber(result.affected_listings)}* active listing(s) are public again.`,
          `_Audit ID ${input.actionKey.slice(0, 12)}_`,
        ].join("\n");
  }

  if (command.type === "blocklist") {
    const { data, error } = await admin.rpc("get_listing_blocklist");
    if (error) throw error;
    const entries = asRecords(data);
    if (!entries.length) return "No listing patterns are blocked.";
    return [
      `*Blocked listing patterns (${entries.length})*`,
      ...entries.map((entry) => `• \`${escapeSlack(entry.pattern)}\` — ${escapeSlack(entry.reason)}`),
    ].join("\n");
  }

  if (command.type === "block" || command.type === "unblock") {
    const block = command.type === "block";
    const { data, error } = await admin.rpc("set_listing_blocklist_pattern", {
      target_pattern: command.pattern,
      block,
      pattern_reason: block ? command.reason : null,
      admin_action_key: input.actionKey,
      slack_user_id: input.slackUserId,
    });
    if (error) {
      const message = safeRpcMessage(error);
      if (message) throw new SlackCommandError(message);
      throw error;
    }
    const result = asRecord(data);
    return block
      ? [
          `Blocked \`${escapeSlack(result.pattern)}\` from listing titles and descriptions.`,
          `*${safeNumber(result.total_patterns)}* pattern(s) now blocked.`,
          `_Reason: ${escapeSlack(command.reason)} · audit ID ${input.actionKey.slice(0, 12)}_`,
        ].join("\n")
      : [
          `Unblocked \`${escapeSlack(result.pattern)}\`.`,
          `*${safeNumber(result.total_patterns)}* pattern(s) still blocked.`,
          `_Audit ID ${input.actionKey.slice(0, 12)}_`,
        ].join("\n");
  }

  // Referral is last and explicit, so a future command type cannot fall
  // through into creating a credit code.
  if (command.type !== "referral") {
    throw new SlackCommandError("Unknown command. Run `/sidespace help`.");
  }

  let data: unknown = null;
  let referralError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await admin.rpc("create_business_referral_code", {
      referral_code: referralCode(),
      referral_cents: command.amountCents,
      admin_action_key: input.actionKey,
      slack_user_id: input.slackUserId,
    });
    data = created.data;
    referralError = created.error;
    if (!created.error || created.error.code !== "23505") break;
  }
  if (referralError) throw referralError;
  const result = asRecord(data);
  const savedCode = safeText(result.code);
  return [
    `Created a new *${money(result.amount_cents)}* Business referral.`,
    `<${referralUrl(savedCode)}|${escapeSlack(savedCode)}>`,
    "One redemption per normalized authenticated email. Ad credit is non-withdrawable and non-transferable.",
    `_Audit ID ${input.actionKey.slice(0, 12)}_`,
  ].join("\n");
}

export async function POST(request: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const expectedTeamId = process.env.SLACK_TEAM_ID;
  const allowedUsers = new Set(
    (process.env.SLACK_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!signingSecret || !expectedTeamId || allowedUsers.size === 0) {
    console.error("Slack admin route is missing its server-only configuration.");
    return slackReply("SideSpace founder commands are not configured.", 503);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 20_000) return slackReply("Request too large.", 413);
  const rawBody = await request.text();
  if (rawBody.length > 20_000) return slackReply("Request too large.", 413);

  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!verifySlackSignature({ rawBody, timestamp, signature, signingSecret })) {
    return slackReply("Invalid Slack signature.", 401);
  }

  const form = new URLSearchParams(rawBody);
  const teamId = form.get("team_id") ?? "";
  const userId = form.get("user_id") ?? "";
  if (teamId !== expectedTeamId || !allowedUsers.has(userId)) {
    return slackReply("This command is restricted to the two SideSpace founders.", 403);
  }

  try {
    return slackReply(
      await runCommand({
        text: form.get("text") ?? "",
        actionKey: slackActionKey(timestamp ?? "", rawBody),
        slackUserId: userId,
      }),
    );
  } catch (error) {
    if (error instanceof SlackCommandError) return slackReply(error.message);
    const code = asRecord(error).code;
    console.error("Slack admin command failed", { code: safeText(code) || "unknown" });
    return slackReply("SideSpace could not complete that founder command. No partial credit or referral change was kept.");
  }
}
