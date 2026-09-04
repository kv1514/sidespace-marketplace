import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "../app/api/slack/admin/route";
import {
  parseDollarAmount,
  parseSlackAdminCommand,
  slackActionKey,
  verifySlackSignature,
} from "../lib/slack/admin";

describe("Slack founder admin trust boundary", () => {
  const originalSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const originalTeamId = process.env.SLACK_TEAM_ID;
  const originalAllowedUsers = process.env.SLACK_ALLOWED_USER_IDS;

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("SLACK_SIGNING_SECRET", originalSigningSecret);
    restore("SLACK_TEAM_ID", originalTeamId);
    restore("SLACK_ALLOWED_USER_IDS", originalAllowedUsers);
  });

  it("verifies Slack signatures and rejects stale or changed bodies", () => {
    const rawBody = "team_id=T123456&user_id=U123456&text=help";
    const timestamp = "1788379200";
    const signingSecret = "test-signing-secret";
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret,
        nowSeconds: Number(timestamp),
      }),
    ).toBe(true);
    expect(
      verifySlackSignature({
        rawBody: `${rawBody}x`,
        timestamp,
        signature,
        signingSecret,
        nowSeconds: Number(timestamp),
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret,
        nowSeconds: Number(timestamp) + 301,
      }),
    ).toBe(false);
  });

  it("derives a stable replay key from the exact Slack request", () => {
    expect(slackActionKey("123", "body")).toMatch(/^[0-9a-f]{64}$/);
    expect(slackActionKey("123", "body")).toBe(slackActionKey("123", "body"));
    expect(slackActionKey("124", "body")).not.toBe(slackActionKey("123", "body"));
  });

  it("parses account, credit, and referral commands", () => {
    expect(parseSlackAdminCommand("stats Founder@Example.com")).toEqual({
      type: "user",
      email: "founder@example.com",
    });
    expect(parseSlackAdminCommand("credit buyer@example.com 25.50 Launch recovery")).toEqual({
      type: "credit",
      email: "buyer@example.com",
      amountCents: 2_550,
      reason: "Launch recovery",
    });
    expect(parseSlackAdminCommand("referral create 10")).toEqual({
      type: "referral",
      amountCents: 1_000,
    });
  });

  it("uses exact cents and enforces the founder liability cap", () => {
    expect(parseDollarAmount("1")).toBe(100);
    expect(parseDollarAmount("25.5")).toBe(2_550);
    expect(parseDollarAmount("5000.00")).toBe(500_000);
    expect(() => parseDollarAmount("0.99")).toThrow(/between \$1 and \$5,000/);
    expect(() => parseDollarAmount("5000.01")).toThrow(/between \$1 and \$5,000/);
    expect(() => parseDollarAmount("1e3")).toThrow(/in dollars/);
  });

  it("requires an auditable reason for direct grants", () => {
    expect(() => parseSlackAdminCommand("credit buyer@example.com 25")).toThrow(/Unknown command/);
    expect(() => parseSlackAdminCommand("credit buyer@example.com 25 no")).toThrow(/reason/);
  });

  async function slackRequest(input: {
    teamId?: string;
    userId?: string;
    signatureOverride?: string;
  }) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = new URLSearchParams({
      team_id: input.teamId ?? "T123456",
      user_id: input.userId ?? "U123456",
      text: "help",
    }).toString();
    const signature = `v0=${createHmac("sha256", "route-signing-secret")
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;
    return POST(
      new Request("https://sidespace.ad/api/slack/admin", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": input.signatureOverride ?? signature,
        },
        body: rawBody,
      }),
    );
  }

  it("returns help ephemerally to an allowed founder in the exact workspace", async () => {
    process.env.SLACK_SIGNING_SECRET = "route-signing-secret";
    process.env.SLACK_TEAM_ID = "T123456";
    process.env.SLACK_ALLOWED_USER_IDS = "U123456,U654321";
    const response = await slackRequest({});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response_type: "ephemeral",
      text: expect.stringContaining("SideSpace founder commands"),
    });
  });

  it("rejects a valid Slack request from anyone outside the two-user allowlist", async () => {
    process.env.SLACK_SIGNING_SECRET = "route-signing-secret";
    process.env.SLACK_TEAM_ID = "T123456";
    process.env.SLACK_ALLOWED_USER_IDS = "U123456,U654321";
    const response = await slackRequest({ userId: "U999999" });
    expect(response.status).toBe(403);
  });

  it("rejects another workspace and a bad signature", async () => {
    process.env.SLACK_SIGNING_SECRET = "route-signing-secret";
    process.env.SLACK_TEAM_ID = "T123456";
    process.env.SLACK_ALLOWED_USER_IDS = "U123456,U654321";
    expect((await slackRequest({ teamId: "T999999" })).status).toBe(403);
    expect(
      (await slackRequest({ signatureOverride: `v0=${"0".repeat(64)}` })).status,
    ).toBe(401);
  });
});

// Moderation commands take a regular expression rather than a dollar amount,
// which makes parsing the risk: a pattern may legitimately contain spaces and
// brackets, so `block <pattern> <reason>` only has one reading if the pattern
// is quoted. The database enforces the rest (valid regex, nothing too broad);
// these pin the boundary the founder actually types at.
describe("Slack moderation commands", () => {
  it("parses suspend and restore, and requires a reason to suspend", () => {
    expect(parseSlackAdminCommand("suspend Person@Example.com Obscene listings")).toEqual({
      type: "suspend",
      email: "person@example.com",
      reason: "Obscene listings",
    });
    expect(parseSlackAdminCommand("ban person@example.com Obscene listings")).toEqual({
      type: "suspend",
      email: "person@example.com",
      reason: "Obscene listings",
    });
    expect(parseSlackAdminCommand("restore person@example.com")).toEqual({
      type: "restore",
      email: "person@example.com",
    });
    expect(parseSlackAdminCommand("unban person@example.com")).toEqual({
      type: "restore",
      email: "person@example.com",
    });
    // No reason means no audit trail, so it is not a suspend command at all.
    expect(() => parseSlackAdminCommand("suspend person@example.com")).toThrow(/Unknown command/);
    expect(() => parseSlackAdminCommand("suspend person@example.com ab")).toThrow(/reason/i);
  });

  it("takes a quoted pattern so a regex containing spaces still parses", () => {
    expect(parseSlackAdminCommand('block "jerkspace" Banned brand')).toEqual({
      type: "block",
      pattern: "jerkspace",
      reason: "Banned brand",
    });
    // Backticks, because that is what people reach for in Slack.
    expect(parseSlackAdminCommand("block `jerk[[:space:]]*space` Banned brand")).toEqual({
      type: "block",
      pattern: "jerk[[:space:]]*space",
      reason: "Banned brand",
    });
    expect(parseSlackAdminCommand('unblock "jerkspace"')).toEqual({
      type: "unblock",
      pattern: "jerkspace",
    });
    expect(parseSlackAdminCommand("blocklist")).toEqual({ type: "blocklist" });
  });

  it("refuses an unquoted pattern rather than guessing where it ends", () => {
    // "block jerk space Banned brand" has no single reading: the pattern could
    // be "jerk", "jerk space", or "jerk space Banned". Guessing here is how a
    // founder blocks something they did not mean to.
    expect(() => parseSlackAdminCommand("block jerk space Banned brand")).toThrow(/quotes/i);
  });

  it("refuses a pattern short enough to catch real businesses", () => {
    // "jerk" alone matches a beef jerky stand and a jerk chicken window, both
    // of which are exactly the kind of listing this marketplace is for.
    expect(() => parseSlackAdminCommand('block "ad" Too broad')).toThrow(/4 to 200/);
    expect(() => parseSlackAdminCommand(`block "${"x".repeat(201)}" Too long`)).toThrow(/4 to 200/);
  });

  it("still parses the money commands unchanged", () => {
    expect(parseSlackAdminCommand("credit person@example.com 25 Launch recovery")).toEqual({
      type: "credit",
      email: "person@example.com",
      amountCents: 2_500,
      reason: "Launch recovery",
    });
    expect(parseSlackAdminCommand("referral 10")).toEqual({ type: "referral", amountCents: 1_000 });
    expect(parseSlackAdminCommand("user person@example.com")).toEqual({
      type: "user",
      email: "person@example.com",
    });
    expect(parseSlackAdminCommand("")).toEqual({ type: "help" });
  });
});
