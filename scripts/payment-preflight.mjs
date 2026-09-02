import { existsSync } from "node:fs";
import process from "node:process";

try {
  process.loadEnvFile(".env.local");
} catch {
  // CI and hosted deployments provide environment variables directly.
}

const requestedMode = process.argv[2] === "live" ? "live" : "sandbox";
const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
}

function longSecret(name) {
  const value = process.env[name] ?? "";
  return value.length >= 32 && !/replace|example|your-/i.test(value);
}

function nonPlaceholder(name, minimumLength) {
  const value = process.env[name] ?? "";
  return value.length >= minimumLength && !/replace|example|your-/i.test(value);
}

function validSupabaseUrl() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function remoteSupabaseUrl() {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const secretPrefix = requestedMode === "live" ? "sk_live_" : "sk_test_";
const publicPrefix = requestedMode === "live" ? "pk_live_" : "pk_test_";
check(
  "Stripe secret key mode",
  nonPlaceholder("STRIPE_SECRET_KEY", 20) &&
    process.env.STRIPE_SECRET_KEY?.startsWith(secretPrefix),
  `expected a non-placeholder ${secretPrefix}… value`,
);
check(
  "Stripe publishable key mode",
  nonPlaceholder("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", 20) &&
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.startsWith(publicPrefix),
  `expected a non-placeholder ${publicPrefix}… value`,
);
check(
  "Webhook signing secret",
  nonPlaceholder("STRIPE_WEBHOOK_SECRET", 20) &&
    process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"),
  "environment-specific whsec_ value",
);
check("Cron secret", longSecret("CRON_SECRET"), "at least 32 non-placeholder characters");
check(
  "Monitoring secret",
  longSecret("PAYMENTS_MONITORING_SECRET"),
  "at least 32 non-placeholder characters and distinct from CRON_SECRET",
);
check(
  "Secrets are distinct",
  Boolean(process.env.CRON_SECRET) &&
    process.env.CRON_SECRET !== process.env.PAYMENTS_MONITORING_SECRET,
  "cron and monitoring must not share a credential",
);
check(
  "Supabase URL",
  validSupabaseUrl(),
  "configured local or hosted Supabase project URL",
);
check(
  "Supabase publishable key",
  nonPlaceholder("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", 20),
  "configured browser-safe Supabase key",
);
check(
  "Supabase server key",
  nonPlaceholder("SUPABASE_SERVICE_ROLE_KEY", 32),
  "configured server-only Supabase key",
);
check(
  "Connect country",
  process.env.STRIPE_CONNECT_COUNTRY === "US",
  "current launch boundary is US",
);
check(
  "Campaign tax code",
  /^txcd_\d+$/.test(process.env.STRIPE_CAMPAIGN_TAX_CODE ?? ""),
  "reviewed Stripe tax code",
);
check(
  "Service-fee tax code",
  /^txcd_\d+$/.test(process.env.STRIPE_SERVICE_FEE_TAX_CODE ?? ""),
  "reviewed Stripe tax code",
);
check(
  "Inventory provenance migration",
  existsSync("supabase/migrations/20260831060000_launch_safety_and_listing_provenance.sql"),
  "migration file present",
);
check(
  "Transfer recovery migration",
  existsSync("supabase/migrations/20260831080000_transfer_recovery.sql"),
  "post-payout refund/dispute recovery migration present",
);
check(
  "Business ad-credit migration",
  existsSync("supabase/migrations/20260902043000_business_signup_ad_credits.sql"),
  "spend-only Business onboarding credit ledger and checkout reservation present",
);
check(
  "Shared Business referral migration",
  existsSync("supabase/migrations/20260902050000_shared_business_referral_code.sql"),
  "shared referral code and once-per-email redemption constraint present",
);
check(
  "Payments runbook",
  existsSync("docs/PAYMENTS_RUNBOOK.md"),
  "operator and rollback instructions present",
);

if (requestedMode === "live") {
  let appUrlIsHttps = false;
  try {
    appUrlIsHttps = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").protocol === "https:";
  } catch {}
  check("HTTPS app origin", appUrlIsHttps, "production NEXT_PUBLIC_APP_URL");
  check(
    "Production Supabase origin",
    remoteSupabaseUrl(),
    "hosted HTTPS Supabase project URL",
  );
  for (const name of [
    "PAYMENTS_LIVE_ENABLED",
    "PAYMENTS_LEGAL_APPROVED",
    "PAYMENTS_TAX_APPROVED",
    "PAYMENTS_OPERATIONS_READY",
    "PAYMENTS_CHECKOUT_ENABLED",
  ]) {
    check(name, process.env[name] === "true", "must be explicitly true");
  }
  check(
    "Vercel Production runtime",
    process.env.VERCEL_ENV === "production",
    "live keys are accepted only when VERCEL_ENV=production",
  );
}

if (requestedMode === "live" || process.env.STRIPE_WEBHOOK_URL) {
  check(
    "Connect webhook signing secret",
    nonPlaceholder("STRIPE_CONNECT_WEBHOOK_SECRET", 20) &&
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.startsWith("whsec_"),
    "separate environment-specific whsec_ value for the hosted Connect endpoint",
  );
  check(
    "Webhook secrets are distinct",
    Boolean(process.env.STRIPE_WEBHOOK_SECRET) &&
      Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET) &&
      process.env.STRIPE_WEBHOOK_SECRET !== process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    "platform and hosted Connect endpoint secrets must not be reused",
  );
}

for (const item of checks) {
  console.log(`${item.pass ? "PASS" : "BLOCKED"}  ${item.name} — ${item.detail}`);
}

const blockers = checks.filter((item) => !item.pass);
console.log(`\n${checks.length - blockers.length}/${checks.length} checks passed for ${requestedMode}.`);
if (blockers.length) process.exitCode = 1;
