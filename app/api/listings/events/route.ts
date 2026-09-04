import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Where impressions and clicks are recorded.
 *
 * The browser never writes to `listing_events` directly. It could have - an
 * insert policy for `anon` would have been fewer moving parts - but these are
 * numbers an owner will decide what to change from, and a table any visitor can
 * insert into is a table anyone can inflate. Going through a route means the
 * two rules below are enforced somewhere a member cannot reach.
 *
 * RULE ONE: an owner's own traffic never counts on their own listing. Without
 * this, the first thing every owner sees is a number made mostly of themselves
 * checking their own page, and the recommender learns the owner's browsing
 * instead of the market's. This is the single most important line in the file.
 *
 * RULE TWO: this endpoint always answers 204, whatever happened. A member
 * browsing listings must never see an error, a toast, or a console failure
 * because analytics had a bad day. Every failure here is silent and the page
 * carries on; the same instinct as `mergeListingLikeCounts`, which lets the
 * grid render when the like counts do not load.
 *
 * Deduplication is the table's primary key, not this route's job: one row per
 * listing, kind, visitor and UTC day, so a re-send is free and the ingest can
 * be careless in the right direction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVENTS = 40;
const MAX_VISITOR_KEY = 64;
const EVENT_KINDS = new Set(["impression", "click"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_KEY = /^[A-Za-z0-9_:-]{8,64}$/;

/** The only response this route ever gives. */
function accepted() {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

type IncomingEvent = { listingId: string; kind: string };

function readEvents(value: unknown): IncomingEvent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const events: IncomingEvent[] = [];
  for (const entry of value.slice(0, MAX_EVENTS)) {
    if (!entry || typeof entry !== "object") continue;
    const { listingId, kind } = entry as Record<string, unknown>;
    if (typeof listingId !== "string" || !UUID.test(listingId)) continue;
    if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) continue;
    const key = `${listingId}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ listingId, kind });
  }
  return events;
}

export async function POST(request: Request) {
  try {
    // Beacons carry an Origin. A mismatch is dropped rather than refused:
    // there is nothing here worth arguing with a caller about.
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return accepted();

    const body = (await request.json().catch(() => null)) as
      | { visitorKey?: unknown; events?: unknown }
      | null;
    if (!body) return accepted();

    const visitorKey =
      typeof body.visitorKey === "string" &&
      body.visitorKey.length <= MAX_VISITOR_KEY &&
      VISITOR_KEY.test(body.visitorKey)
        ? body.visitorKey
        : "";
    if (!visitorKey) return accepted();

    const events = readEvents(body.events);
    if (!events.length) return accepted();

    // Signing in is optional - most of the traffic worth measuring is not.
    let userId: string | null = null;
    let viewerProfileId: string | null = null;
    try {
      const authClient = await createClient();
      const {
        data: { user },
      } = await authClient.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      // An unreadable session is just an anonymous visitor.
    }

    const admin = createAdminClient();

    if (userId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("id")
        .eq("auth_user_id", userId)
        .maybeSingle();
      viewerProfileId = (profile?.id as string | undefined) ?? null;
    }

    let listingIds = [...new Set(events.map((event) => event.listingId))];

    // RULE ONE. Ask which of these the viewer owns, and drop those.
    if (viewerProfileId) {
      const { data: owned } = await admin
        .from("listings")
        .select("id")
        .eq("owner_profile_id", viewerProfileId)
        .in("id", listingIds);
      const ownIds = new Set((owned ?? []).map((row) => row.id as string));
      if (ownIds.size) {
        listingIds = listingIds.filter((id) => !ownIds.has(id));
      }
    }

    const allowed = new Set(listingIds);
    const rows = events
      .filter((event) => allowed.has(event.listingId))
      .map((event) => ({
        listing_id: event.listingId,
        kind: event.kind,
        visitor_key: visitorKey,
        user_id: userId,
      }));
    if (!rows.length) return accepted();

    await admin
      .from("listing_events")
      .upsert(rows, {
        onConflict: "listing_id,kind,visitor_key,day",
        ignoreDuplicates: true,
      });
  } catch (error) {
    // RULE TWO holds: the member never sees this. But it is not allowed to be
    // invisible to US - a missing service key or a refused upsert here means
    // every impression on the site is being quietly dropped, and the only way
    // anyone finds out is a dashboard full of zeroes. Log it where Vercel
    // keeps it.
    console.error("[listing events] batch not recorded:", error);
  }
  return accepted();
}
