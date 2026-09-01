#!/usr/bin/env node
/**
 * SideSpace → Instagram, via the official Graph API.
 *
 * This uses "Instagram API with Instagram Login", which as of 2026-09 needs
 * NO linked Facebook Page and NO App Review to post to an account you own.
 * Meta calls that Standard Access: "if your app serves Instagram professional
 * accounts you own or manage." Advanced Access / App Review is only for acting
 * on accounts you do not own.
 *
 * It deliberately does NOT use instagrapi or any private-API client. Those log
 * in with your password, are a terms-of-use violation, and get accounts
 * disabled. Everything here is a documented, revocable, token-scoped endpoint.
 *
 * No dependencies — Node 18+ for native fetch.
 *
 * Environment:
 *   IG_ACCESS_TOKEN   required for everything except `exchange`
 *   IG_USER_ID        optional; resolved from /me when omitted
 *   IG_APP_SECRET     required only for `exchange`
 *   IG_API_VERSION    optional, defaults below — bump if Meta has moved on
 *
 * Usage:
 *   node scripts/instagram.mjs me
 *   node scripts/instagram.mjs limit
 *   node scripts/instagram.mjs exchange <short-lived-token>
 *   node scripts/instagram.mjs refresh
 *   node scripts/instagram.mjs post <public-jpeg-url> [caption...]
 */

const API = "https://graph.instagram.com";
const VERSION = process.env.IG_API_VERSION || "v23.0";

const TOKEN = process.env.IG_ACCESS_TOKEN || "";
const APP_SECRET = process.env.IG_APP_SECRET || "";

/**
 * One place to talk to Meta, because their errors are the whole story when
 * something fails. A bad token and an unreachable image_url both come back as
 * HTTP 400 with completely different `error.code`s, and printing the raw body
 * is the difference between a two-minute fix and an hour of guessing.
 */
async function call(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON reply from Meta (HTTP ${response.status}):\n${text}`);
  }

  if (!response.ok || body.error) {
    const e = body.error ?? {};
    throw new Error(
      [
        `Meta rejected the call (HTTP ${response.status}).`,
        e.message && `  message:  ${e.message}`,
        e.type && `  type:     ${e.type}`,
        e.code !== undefined && `  code:     ${e.code}`,
        e.error_subcode !== undefined && `  subcode:  ${e.error_subcode}`,
      ].filter(Boolean).join("\n"),
    );
  }
  return body;
}

function form(fields) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

function requireToken() {
  if (!TOKEN) {
    throw new Error("IG_ACCESS_TOKEN is not set. See the header of this file.");
  }
  return TOKEN;
}

/** The IG user id is stable, so let the caller pin it and skip a round trip. */
async function resolveUserId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const me = await call(
    `${API}/${VERSION}/me?fields=id&access_token=${encodeURIComponent(requireToken())}`,
  );
  return me.id;
}

async function cmdMe() {
  const me = await call(
    `${API}/${VERSION}/me?fields=id,username,account_type&access_token=${encodeURIComponent(requireToken())}`,
  );
  console.log(JSON.stringify(me, null, 2));
  if (me.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(me.account_type)) {
    console.warn(
      `\nHeads up: account_type is ${me.account_type}. Publishing needs a ` +
        `Business or Creator account. Switch it free in the Instagram app: ` +
        `Settings → Account type and tools → Switch to professional account.`,
    );
  }
}

/** 100 published posts per rolling 24h. Worth checking before a batch. */
async function cmdLimit() {
  const id = await resolveUserId();
  const data = await call(
    `${API}/${VERSION}/${id}/content_publishing_limit?access_token=${encodeURIComponent(requireToken())}`,
  );
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Short-lived tokens (what the login redirect hands you) last about an hour.
 * This trades one for a 60-day token. A short-lived token can only be
 * exchanged once, so capture the output.
 */
async function cmdExchange(shortLived) {
  if (!shortLived) throw new Error("Usage: exchange <short-lived-token>");
  if (!APP_SECRET) throw new Error("IG_APP_SECRET is not set.");

  const url =
    `${API}/access_token?grant_type=ig_exchange_token` +
    `&client_secret=${encodeURIComponent(APP_SECRET)}` +
    `&access_token=${encodeURIComponent(shortLived)}`;

  const data = await call(url);
  const days = data.expires_in ? Math.round(data.expires_in / 86400) : "?";
  console.log(`Long-lived token (~${days} days):\n\n${data.access_token}\n`);
  console.log("Store it as IG_ACCESS_TOKEN. Refresh before it expires.");
}

/**
 * Extends a long-lived token by another 60 days. The token must be at least
 * 24 hours old and not yet expired — so refreshing on a schedule beats
 * refreshing in a panic. Let it lapse and you redo the login flow by hand.
 */
async function cmdRefresh() {
  const url =
    `${API}/refresh_access_token?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(requireToken())}`;

  const data = await call(url);
  const days = data.expires_in ? Math.round(data.expires_in / 86400) : "?";
  console.log(`Refreshed (~${days} days):\n\n${data.access_token}\n`);
}

/**
 * Publishing is two calls: build a container, then publish it.
 *
 * The image must be a publicly reachable JPEG — Meta cURLs the URL from their
 * own servers at publish time, so localhost, a signed URL that has expired, or
 * anything behind auth fails with an unhelpful message. Something under
 * Vercel's /public on sidespace-marketplace.vercel.app works.
 */
async function cmdPost(imageUrl, caption) {
  if (!imageUrl) throw new Error("Usage: post <public-jpeg-url> [caption...]");
  if (!/^https:\/\//i.test(imageUrl)) {
    throw new Error("image_url must be a public https:// URL that Meta can fetch.");
  }

  const token = requireToken();
  const id = await resolveUserId();

  const container = await call(
    `${API}/${VERSION}/${id}/media`,
    form({ image_url: imageUrl, ...(caption ? { caption } : {}), access_token: token }),
  );
  console.log(`container: ${container.id}`);

  // Images are usually FINISHED immediately, but checking costs one cheap call
  // and turns a confusing publish failure into a legible one.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await call(
      `${API}/${VERSION}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    );
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Container ${status.status_code}: ${status.status ?? "no detail"}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const published = await call(
    `${API}/${VERSION}/${id}/media_publish`,
    form({ creation_id: container.id, access_token: token }),
  );
  console.log(`published: ${published.id}`);
}

const [command, ...rest] = process.argv.slice(2);

const commands = {
  me: cmdMe,
  limit: cmdLimit,
  exchange: () => cmdExchange(rest[0]),
  refresh: cmdRefresh,
  post: () => cmdPost(rest[0], rest.slice(1).join(" ")),
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command: ${command ?? "(none)"}`);
  console.error(`Try one of: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}

run().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
