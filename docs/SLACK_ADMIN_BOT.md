# SideSpace founder Slack command

SideSpace exposes one founder-only Slack slash command at
`POST /api/slack/admin`. It does not need a Slack bot token or permission to
read channels. Every reply is ephemeral, so account and financial summaries
are visible only to the founder who invoked the command.

## Commands

```text
/sidespace user person@example.com
/sidespace credit person@example.com 25 Launch recovery
/sidespace referral 10
```

`user` returns profile state, listings, campaign counts, spend-only ad credit,
SideSpace payment/payout ledger totals, and the connected Stripe account's live
USD available/pending balance when Stripe responds. Ledger figures and live
provider balance are labeled separately; an unavailable Stripe lookup does not
hide the SideSpace summary.

`credit` grants a Business profile between $1 and $5,000 of advertising-only
credit. The reason is required. Credits reduce what the Business pays at
Checkout, do not reduce the Creator's agreed payout, and cannot be withdrawn or
transferred.

`referral` creates a cryptographically random code with a database uniqueness
constraint. A recipient who completes Business onboarding can redeem it once;
the permanent normalized-auth-email tombstone prevents account deletion from
making the promotion reusable.

Slack retries are safe. The signed request becomes a unique action key, and the
credit/referral mutation plus private audit record commit in one database
transaction.

## One-time Slack setup

1. Create a Slack app for the SideSpace workspace at `api.slack.com/apps`.
2. Under **Slash Commands**, create `/sidespace` with request URL
   `https://sidespace.ad/api/slack/admin` and install the app to the workspace.
3. Copy the app's **Signing Secret**, the workspace/team ID, and the immutable
   Slack member IDs for Aiden and KV. Member IDs are available from each Slack
   profile's **Copy member ID** action.
4. Add these encrypted, server-only Vercel Production variables:

   ```text
   SLACK_SIGNING_SECRET=...
   SLACK_TEAM_ID=T...
   SLACK_ALLOWED_USER_IDS=U_AIDEN,U_KV
   ```

5. Apply `20260902060000_slack_founder_admin.sql`, deploy the matching app
   commit, then run `/sidespace help` and test with controlled Business and
   non-Business accounts.

Do not add a Slack bot OAuth token, service-role key, Stripe secret, email, or
financial value to a Slack command or channel message. The endpoint needs only
Slack's request signature and the existing server-only Supabase service role.
