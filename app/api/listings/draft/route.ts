import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/payments/request";
import {
  LISTING_DRAFT_SCHEMA,
  normalizeListingDraft,
  type ListingDraftKind,
} from "@/lib/listings/draft";

/**
 * "Fill with AI": a photo of the space plus a few words in, a complete
 * listing draft out. The member edits it in the form and presses Publish -
 * this route never writes a listing.
 *
 * Backed by the Gemini API (Interactions endpoint) over plain fetch. Needs
 * GEMINI_API_KEY; a Google AI Studio key works and has a free tier.
 */

const MODEL = "gemini-3.7-flash";
const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
/** ~2 MB decoded. The form re-encodes photos to ~300 KB JPEG before sending. */
const MAX_IMAGE_BASE64 = 2_800_000;
const MAX_NOTES = 600;
const DRAFTS_PER_HOUR = 20;

const KINDS: ListingDraftKind[] = ["physical", "social", "sponsorship"];

function systemPrompt(kind: ListingDraftKind, city: string) {
  const what =
    kind === "physical"
      ? "a physical advertising space someone owns - a storefront window, a wall, a counter, a vehicle, a community board, a room, a yard sign"
      : kind === "sponsorship"
        ? "a sponsorship a team, club, or event is offering - a banner, jerseys, a named tier, a shout-out"
        : "a placement a local creator sells on their own social account, newsletter, or site";
  return [
    "You draft listings for SideSpace, a marketplace where local businesses rent everyday advertising space from the people who own it.",
    `This listing is ${what}. Write it in the owner's voice, first person, plain and specific. No marketing fluff, no exclamation marks, no emoji, and never mention AI.`,
    "",
    "Use only what the photo shows and the notes say. Never invent a street address, a foot-traffic count, a follower count, or an audience percentage. When something is unknown, describe it in words or leave that field as an empty string - a blank the owner fills is better than a number you made up.",
    "",
    "Field rules:",
    "- title: at most 8 words. Name the space and, if known, the street or area. Example: \"Cafe window, Main Street\".",
    "- format: finishes the sentence \"You get ...\" exactly as it should read on the card. Example: \"one letter-size poster in my front window for a week\".",
    "- description: two to four sentences. What it is, where exactly it sits, who walks or scrolls past.",
    "- demographics: who actually sees it, in words. No percentages unless the notes give them.",
    `- location_area: the city or area from the notes${city ? `, otherwise "${city}"` : ""}. Never a street address.`,
    "- space_size: rough width by height when the photo or notes make it clear, otherwise empty.",
    "- surface_types: only what would plausibly go on this space. Empty for anything that is not a physical surface.",
    "- install_by: \"owner\", \"renter\", or \"either\" only if the notes say who puts the ad up; otherwise an empty string.",
    "- price_dollars: a modest, realistic asking price in whole US dollars for a small local placement. Use the notes' price if given.",
    `- price_unit: ${kind === "physical" ? '"week" unless the notes say otherwise' : kind === "sponsorship" ? '"campaign" or "sponsor"' : '"post", "story", or "video" to match the format'}.`,
    "- minimum_booking and availability_notes: from the notes, otherwise empty.",
    "- deliverables: the proof handed back after booking, one or two sentences. For a physical space, a photo of the ad in place.",
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) {
    throw new ApiError("This request did not come from SideSpace.", 403);
  }
}

async function requireMember() {
  const authClient = await createClient();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();
  if (error || !user) throw new ApiError("Sign in to draft a listing.", 401);

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id,city")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) throw new ApiError("Finish setting up your profile first.", 403);
  return { profile, admin };
}

type Body = {
  kind: ListingDraftKind;
  notes: string;
  image: string | null;
  city: string;
};

async function readBody(request: Request): Promise<Body> {
  const raw = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!raw) throw new ApiError("Send a photo or a few words to draft from.");

  const kind = KINDS.includes(raw.kind as ListingDraftKind)
    ? (raw.kind as ListingDraftKind)
    : "physical";
  const notes =
    typeof raw.notes === "string" ? raw.notes.trim().slice(0, MAX_NOTES) : "";
  const image = typeof raw.image === "string" ? raw.image.trim() : null;
  if (image) {
    if (image.length > MAX_IMAGE_BASE64) {
      throw new ApiError("That photo is too large to draft from. Try a smaller one.", 413);
    }
    if (!/^[A-Za-z0-9+/]+=*$/.test(image)) {
      throw new ApiError("That photo could not be read.");
    }
  }
  if (!image && !notes) {
    throw new ApiError("Add a photo or a few words first, then press Fill with AI.");
  }
  const city = typeof raw.city === "string" ? raw.city.trim().slice(0, 80) : "";
  return { kind, notes, image, city };
}

/** The Interactions response, as much of it as this route reads. */
type GeminiResponse = {
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: number; message?: string; status?: string };
};

async function callGemini(apiKey: string, body: Body) {
  const input: Array<Record<string, string>> = [];
  if (body.image) {
    // The form always sends a canvas-encoded JPEG.
    input.push({ type: "image", data: body.image, mime_type: "image/jpeg" });
  }
  input.push({
    type: "text",
    text: [
      body.image
        ? "Draft the listing for the space in this photo."
        : "Draft the listing from these notes.",
      body.notes ? `Owner's notes: ${body.notes}` : "The owner left no notes.",
      body.city ? `Owner's profile city: ${body.city}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      system_instruction: systemPrompt(body.kind, body.city),
      input,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: LISTING_DRAFT_SCHEMA,
      },
      generation_config: { thinking_level: "low" },
    }),
  });
  const json = (await response.json().catch(() => ({}))) as GeminiResponse;
  return { ...json, httpStatus: response.status };
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ApiError("Fill with AI is not set up on this deployment yet.", 503);
    }
    const { profile, admin } = await requireMember();

    const { data: allowed, error: limitError } = await admin.rpc(
      "claim_payment_rate_limit",
      {
        rate_bucket: "listing_draft",
        subject_profile_id: profile.id,
        max_requests: DRAFTS_PER_HOUR,
        window_seconds: 3600,
      },
    );
    if (limitError) throw limitError;
    if (!allowed) {
      throw new ApiError(
        "That is plenty of drafts for one hour. Edit what you have, or try again later.",
        429,
      );
    }

    const body = await readBody(request);
    if (!body.city && profile.city) body.city = String(profile.city);

    const result = await callGemini(apiKey, body);

    if (result.httpStatus === 401 || result.httpStatus === 403) {
      console.error("[listing draft] Gemini rejected the API key", result.error);
      throw new ApiError("Fill with AI is not set up correctly on this deployment.", 503);
    }
    if (result.httpStatus === 429 || result.httpStatus >= 500) {
      throw new ApiError("The drafting service is busy. Try again in a moment.", 503);
    }
    if (result.httpStatus !== 200) {
      console.error("[listing draft] Gemini returned", result.httpStatus, result.error);
      throw new ApiError("SideSpace could not draft this listing right now.", 502);
    }

    const text = result.steps
      ?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .find((part) => part.type === "text" && part.text)?.text;
    if (!text) {
      console.error("[listing draft] no model output", result.status, result.error);
      throw new ApiError(
        "SideSpace could not draft from that. Try different notes or another photo.",
        422,
      );
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const draft = normalizeListingDraft(parsed, body.kind);
    if (!draft) {
      console.error("[listing draft] unusable draft", text.slice(0, 400));
      throw new ApiError("The draft came back incomplete. Try again.", 502);
    }

    return Response.json(
      { draft },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[listing draft] failed", error);
    return Response.json(
      { error: "SideSpace could not draft this listing right now." },
      { status: 500 },
    );
  }
}
