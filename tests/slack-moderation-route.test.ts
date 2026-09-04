import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The moderation commands are only useful if the whole chain lines up:
// signature -> allowlist -> parse -> RPC name and parameter names -> reply.
// The pgTAP tests cover the database half and the parser tests cover the text
// half; nothing until now covered the wiring between them, which is exactly
// where a renamed RPC parameter would go unnoticed until a founder ran it.
const rpcCalls: Array<{ fn: string; params: unknown }> = [];
let rpcResponse: (fn: string) => { data: unknown; error: unknown } = () => ({
  data: {},
  error: null,
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, params?: unknown) => {
      rpcCalls.push({ fn, params });
      return rpcResponse(fn);
    },
  }),
}));

const { POST } = await import("../app/api/slack/admin/route");

const SECRET = "route-signing-secret";

async function slackCommand(text: string, userId = "U123456") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = new URLSearchParams({
    team_id: "T123456",
    user_id: userId,
    text,
  }).toString();
  const signature = `v0=${createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const response = await POST(
    new Request("https://sidespace.ad/api/slack/admin", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    }),
  );
  return { status: response.status, body: (await response.json()) as { text: string } };
}

describe("Slack moderation commands, end to end through the route", () => {
  const original = {
    secret: process.env.SLACK_SIGNING_SECRET,
    team: process.env.SLACK_TEAM_ID,
    users: process.env.SLACK_ALLOWED_USER_IDS,
  };

  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResponse = () => ({ data: {}, error: null });
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_TEAM_ID = "T123456";
    process.env.SLACK_ALLOWED_USER_IDS = "U123456,U654321";
  });

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("SLACK_SIGNING_SECRET", original.secret);
    restore("SLACK_TEAM_ID", original.team);
    restore("SLACK_ALLOWED_USER_IDS", original.users);
  });

  it("lists the moderation commands in help", async () => {
    const { body } = await slackCommand("help");
    expect(body.text).toContain("/sidespace suspend");
    expect(body.text).toContain("/sidespace restore");
    expect(body.text).toContain("/sidespace block");
    expect(body.text).toContain("/sidespace unblock");
    expect(body.text).toContain("/sidespace blocklist");
  });

  it("sends suspend to the RPC under the parameter names the function declares", async () => {
    rpcResponse = () => ({
      data: {
        email: "person@example.com",
        display_name: "Someone",
        suspended: true,
        affected_listings: 3,
      },
      error: null,
    });
    const { body } = await slackCommand("suspend person@example.com Obscene listings");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("set_member_suspension_by_email");
    // These five keys are the function's declared argument names. A rename on
    // either side silently produces "function does not exist" at runtime.
    expect(Object.keys(rpcCalls[0].params as object).sort()).toEqual([
      "admin_action_key",
      "slack_user_id",
      "suspend",
      "suspend_reason",
      "target_email",
    ]);
    expect(rpcCalls[0].params).toMatchObject({
      target_email: "person@example.com",
      suspend: true,
      suspend_reason: "Obscene listings",
      slack_user_id: "U123456",
    });
    expect(body.text).toContain("Suspended");
    expect(body.text).toContain("3");
  });

  it("sends restore as the same RPC with suspend false and no reason", async () => {
    rpcResponse = () => ({
      data: { email: "person@example.com", display_name: "Someone", suspended: false, affected_listings: 2 },
      error: null,
    });
    const { body } = await slackCommand("restore person@example.com");
    expect(rpcCalls[0].fn).toBe("set_member_suspension_by_email");
    expect(rpcCalls[0].params).toMatchObject({ suspend: false, suspend_reason: null });
    expect(body.text).toContain("Restored");
  });

  it("sends block and unblock with the pattern under target_pattern", async () => {
    rpcResponse = () => ({ data: { pattern: "jerkspace", blocked: true, total_patterns: 2 }, error: null });
    await slackCommand('block "jerkspace" Banned brand');
    expect(rpcCalls[0].fn).toBe("set_listing_blocklist_pattern");
    expect(Object.keys(rpcCalls[0].params as object).sort()).toEqual([
      "admin_action_key",
      "block",
      "pattern_reason",
      "slack_user_id",
      "target_pattern",
    ]);
    expect(rpcCalls[0].params).toMatchObject({
      target_pattern: "jerkspace",
      block: true,
      pattern_reason: "Banned brand",
    });

    rpcCalls.length = 0;
    rpcResponse = () => ({ data: { pattern: "jerkspace", blocked: false, total_patterns: 1 }, error: null });
    await slackCommand('unblock "jerkspace"');
    expect(rpcCalls[0].params).toMatchObject({ target_pattern: "jerkspace", block: false, pattern_reason: null });
  });

  it("reads the blocklist without arguments and renders each pattern", async () => {
    rpcResponse = () => ({
      data: [
        { pattern: "jerk[[:space:]_-]*space", reason: "Banned brand: Jerkspace", created_at: "2026-09-04" },
      ],
      error: null,
    });
    const { body } = await slackCommand("blocklist");
    expect(rpcCalls[0].fn).toBe("get_listing_blocklist");
    expect(rpcCalls[0].params).toBeUndefined();
    expect(body.text).toContain("jerk[[:space:]_-]*space");
    expect(body.text).toContain("Banned brand: Jerkspace");
  });

  // The collateral-damage refusal is the whole safety story, and it is useless
  // if the founder sees a generic failure instead of which listings they were
  // about to take down.
  it("shows the founder exactly which listings a too-broad pattern would have blocked", async () => {
    rpcResponse = () => ({
      data: null,
      error: {
        message:
          "That pattern would block 2 listing(s) from members in good standing: Beef jerky stand · Jamaican jerk chicken window",
      },
    });
    const { body } = await slackCommand('block "jerky" Banned brand');
    expect(body.text).toContain("Beef jerky stand");
    expect(body.text).toContain("Jamaican jerk chicken window");
  });

  it("does not leak an unexpected database error to Slack", async () => {
    rpcResponse = () => ({
      data: null,
      error: { message: 'relation "private.slack_admin_actions" does not exist', code: "42P01" },
    });
    const { body } = await slackCommand('block "quxzzybrand" Banned brand');
    expect(body.text).not.toContain("slack_admin_actions");
    expect(body.text).not.toContain("42P01");
    expect(body.text).toContain("could not complete");
  });

  it("refuses a moderation command from outside the founder allowlist, before any RPC runs", async () => {
    const { status, body } = await slackCommand("suspend person@example.com Obscene listings", "U999999");
    expect(status).toBe(403);
    expect(body.text).toContain("restricted");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects a bad pattern in the parser, before any RPC runs", async () => {
    const shortPattern = await slackCommand('block "ad" Too broad');
    expect(shortPattern.body.text).toContain("4 to 200");
    const unquoted = await slackCommand("block jerk space Banned brand");
    expect(unquoted.body.text).toMatch(/quotes/i);
    expect(rpcCalls).toHaveLength(0);
  });
});
