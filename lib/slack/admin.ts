import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MIN_ADMIN_CREDIT_CENTS = 100;
export const MAX_ADMIN_CREDIT_CENTS = 500_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SlackCommandError extends Error {}

export type SlackAdminCommand =
  | { type: "help" }
  | { type: "user"; email: string }
  | { type: "credit"; email: string; amountCents: number; reason: string }
  | { type: "referral"; amountCents: number };

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
    const reason = creditMatch[3].trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new SlackCommandError("Add a reason between 3 and 500 characters for the audit log.");
    }
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

  throw new SlackCommandError(
    "Unknown command. Run `/sidespace help` to see the founder commands.",
  );
}
