// Drains the notification outbox through Resend.
//
// pg_cron wakes this every minute when, and only when, something is queued.
// Postgres decides what may be sent - private.claim_notification_batch claims
// rows with `for update skip locked` and stamps them, so two overlapping runs
// can never hold the same row. This function's only job is to take what it was
// handed, send it, and write back what happened.
//
// It sends exactly what is stored. It never composes a notification, never
// substitutes a recipient, and never marks sent what it did not send: the row
// is marked only after Resend returns a message id.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Appended to every notification, so a recipient always knows why it reached
// them. Kept here rather than in the row so the wording is one thing.
const FOOTER = [
  "SideSpace",
  "You're getting this because someone contacted you about a listing on SideSpace.",
].join("\n");

type Claimed = {
  id: string;
  email: string;
  subject: string;
  body: string;
  kind: string;
};

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set on this function.`);
  return value;
}

async function rpc(path: string, payload: unknown): Promise<Response> {
  const url = required("SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  // These are the public wrappers, granted to service_role alone. The real
  // helpers stay in private, which PostgREST does not serve.
  return await fetch(`${url}/rest/v1/rpc/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });
}

async function send(row: Claimed): Promise<string> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${required("RESEND_API_KEY")}`,
    },
    body: JSON.stringify({
      from: Deno.env.get("OUTBOX_FROM") ?? "SideSpace <notifications@sidespace.ad>",
      to: [row.email],
      subject: row.subject,
      text: `${row.body}\n\n${FOOTER}`,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${text.slice(0, 300)}`);
  }
  const id = (JSON.parse(text) as { id?: string }).id;
  if (!id) throw new Error("Resend accepted the request but returned no id.");
  return id;
}

Deno.serve(async (request: Request) => {
  // The URL is public, so the shared secret is what makes this ours. A wrong
  // or missing secret is indistinguishable from a wrong URL to a caller.
  if (request.headers.get("x-outbox-secret") !== required("OUTBOX_SHARED_SECRET")) {
    return new Response("Not found", { status: 404 });
  }

  const claim = await rpc("claim_notification_batch", { p_limit: 25 });
  if (!claim.ok) {
    const detail = await claim.text();
    console.error("claim failed", claim.status, detail);
    return new Response(JSON.stringify({ error: "claim failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rows = (await claim.json()) as Claimed[];
  let sent = 0;
  const failures: Array<{ id: string; error: string }> = [];

  for (const row of rows) {
    try {
      const messageId = await send(row);
      await rpc("mark_notification_sent", { p_id: row.id });
      sent += 1;
      console.log(`sent ${row.kind} ${row.id} as ${messageId}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // The row keeps the attempt it spent claiming, so a permanently broken
      // address dead-letters at three rather than retrying forever.
      await rpc("mark_notification_failed", { p_id: row.id, p_error: message });
      failures.push({ id: row.id, error: message });
      console.error(`failed ${row.kind} ${row.id}: ${message}`);
    }
  }

  return new Response(
    JSON.stringify({ claimed: rows.length, sent, failed: failures.length, failures }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
