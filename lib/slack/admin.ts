import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MIN_ADMIN_CREDIT_CENTS = 100;
export const MAX_ADMIN_CREDIT_CENTS = 500_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SlackCommandError extends Error {}

export const MIN_BLOCKLIST_PATTERN = 4;
export const MAX_BLOCKLIST_PATTERN = 200;

export type SlackAdminCommand =
  | { type: "help" }
  | { type: "user"; email: string }
  | { type: "credit"; email: string; amountCents: number; reason: string }
  | { type: "referral"; amountCents: number }
  | { type: "suspend"; email: string; reason: string }
  | { type: "restore"; email: string }
  | { type: "block"; pattern: string; reason: string }
  | { type: "unblock"; pattern: string }
  | { type: "blocklist" };

export function verifySlackSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  nowSeconds?: number;
}) {
  if (!/^\d+$/.test(input.timestamp ?? "") || !/^v0=[0-9a-f]{64}$/.test(input.signature ?? "")) {
    return false;
  }

  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 60 * 5) {
    return false;
  }

  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  const received = input.signature ?? "";
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function slackActionKey(timestamp: string, rawBody: string) {
  return createHash("sha256")
    .update(`${timestamp}:${rawBody}`)
    .digest("hex");
}

function requireReason(value: string, what: string) {
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new SlackCommandError(`Add a reason between 3 and 500 characters for the ${what}.`);
  }
  return reason;
}

/**
 * A blocklist pattern is a regular expression, so it may contain spaces and
 * brackets. Requiring it quoted is what keeps `block <pattern> <reason>`
 * unambiguous - without it, `block jerk space Banned brand` has no single
 * reading. Backticks are accepted because Slack users reach for them first.
 */
function readQuotedPattern(raw: string) {
  const match = /^(?:"([^"]+)"|`([^`]+)`)\s*([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    throw new SlackCommandError(
      'Wrap the pattern in quotes, such as `/sidespace block "jerkspace" Banned brand`.',
    );
  }
  const pattern = (match[1] ?? match[2]).trim();
  if (pattern.length < MIN_BLOCKLIST_PATTERN || pattern.length > MAX_BLOCKLIST_PATTERN) {
    throw new SlackCommandError(
      `A pattern must be ${MIN_BLOCKLIST_PATTERN} to ${MAX_BLOCKLIST_PATTERN} characters. Short patterns block real businesses.`,
    );
  }
  return { pattern, rest: match[3] ?? "" };
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) {
    throw new SlackCommandError("Enter a valid email address.");
  }
  return email;
}

export function parseDollarAmount(value: string) {
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(value)) {
    throw new SlackCommandError("Enter the credit amount in dollars, such as `25` or `25.50`.");
  }
  const [whole, fraction = ""] = value.split(".");
  const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (amountCents < MIN_ADMIN_CREDIT_CENTS || amountCents > MAX_ADMIN_CREDIT_CENTS) {
    throw new SlackCommandError("Credit amounts must be between $1 and $5,000.");
  }
  return amountCents;
}

export function parseSlackAdminCommand(input: string): SlackAdminCommand {
  const text = input.trim();
  if (!text || /^(help|commands)$/i.test(text)) return { type: "help" };

  const userMatch = /^(?:user|stats)\s+(\S+)$/i.exec(text);
  if (userMatch) return { type: "user", email: normalizeEmail(userMatch[1]) };

  const creditMatch = /^(?:credit|grant)\s+(\S+)\s+(\S+)\s+(.+)$/i.exec(text);
  if (creditMatch) {
    const reason = requireReason(creditMatch[3], "audit log");
    return {
      type: "credit",
      email: normalizeEmail(creditMatch[1]),
      amountCents: parseDollarAmount(creditMatch[2]),
      reason,
    };
  }

  const referralMatch = /^referral(?:\s+create)?\s+(\S+)$/i.exec(text);
  if (referralMatch) {
    return { type: "referral", amountCents: parseDollarAmount(referralMatch[1]) };
  }

  const suspendMatch = /^(?:suspend|ban)\s+(\S+)\s+(.+)$/i.exec(text);
  if (suspendMatch) {
    return {
      type: "suspend",
      email: normalizeEmail(suspendMatch[1]),
      reason: requireReason(suspendMatch[2], "audit log"),
    };
  }

  const restoreMatch = /^(?:restore|unsuspend|unban)\s+(\S+)$/i.exec(text);
  if (restoreMatch) {
    return { type: "restore", email: normalizeEmail(restoreMatch[1]) };
  }

  if (/^blocklist$/i.test(text)) return { type: "blocklist" };

  const blockMatch = /^block\s+([\s\S]+)$/i.exec(text);
  if (blockMatch) {
    const { pattern, rest } = readQuotedPattern(blockMatch[1]);
    return { type: "block", pattern, reason: requireReason(rest, "audit log") };
  }

  const unblockMatch = /^unblock\s+([\s\S]+)$/i.exec(text);
  if (unblockMatch) {
    return { type: "unblock", pattern: readQuotedPattern(unblockMatch[1]).pattern };
  }

  throw new SlackCommandError(
    "Unknown command. Run `/sidespace help` to see the founder commands.",
  );
}
