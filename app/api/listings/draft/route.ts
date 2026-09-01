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
 * Two providers, chosen by which key the deployment has. ANTHROPIC_API_KEY
 * wins when both are set; GEMINI_API_KEY is the fallback (Google AI Studio
 * keys have a free tier). Both are called over plain fetch: neither SDK is a
 * dependency here and the lockfile could not be regenerated where this was
 * written. Swapping in an SDK later touches only the provider function.
 */

const ANTHROPIC_MODEL = "claude-opus-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** ~2 MB decoded. The form re-encodes photos to ~300 KB JPEG before sending. */
const MAX_IMAGE_BASE64 = 2_800_000;
const MAX_NOTES = 600;
const DRAFTS_PER_HOUR = 20;

const KINDS: ListingDraftKind[] = ["physical", "social", "sponsorship"];

type Provider = "anthropic" | "gemini";

function pickProvider(): { provider: Provider; apiKey: string } | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.GEMINI_API_KEY) {
    return { provider: "gemini", apiKey: process.env.GEMINI_API_KEY };
  }
  return null;
}

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
    "Use only what the photo shows and the notes say. NEVER infer, estimate, round up, or invent: not a price, not a size, not a foot-traffic, follower, or attendance number, not an address, not an availability window, not who installs. If the owner did not state it and the photo does not show it, leave that field empty (null for price) and ask for it in questions. A blank the owner fills is right; a number you made up is a failure.",
    "",
    "Field rules:",
    "- title: at most 8 words. Name the space and, if known, the street or area. Example: \"Cafe window, Main Street\".",
    "- format: finishes the sentence \"You get ...\" exactly as it should read on the card. Example: \"one letter-size poster in my front window for a week\".",
    "- description: two to four sentences. What it is, where exactly it sits, who walks or scrolls past.",
    "- demographics: only what the owner said about who sees it and how many. Empty when they said nothing.",
    `- location_area: the city or area from the notes${city ? `, otherwise "${city}"` : ""}. Never a street address.`,
    "- space_size: only when the owner stated it or the photo shows a measurable reference; otherwise empty.",
    "- surface_types: only what would plausibly go on this space. Empty for anything that is not a physical surface.",
    "- install_by: \"owner\", \"renter\", or \"either\" only if the notes say who puts the ad up; otherwise an empty string.",
    "- price_dollars: only the price the owner stated, in whole US dollars. null when they did not say. Never suggest one.",
    `- price_unit: ${kind === "physical" ? '"week" unless the notes say otherwise' : kind === "sponsorship" ? '"campaign" or "sponsor"' : '"post", "story", or "video" to match the format'}.`,
    "- minimum_booking and availability_notes: from the notes, otherwise empty.",
    "- deliverables: the proof handed back after booking, one or two sentences. For a physical space, a photo of the ad in place. This one may be drafted; it describes the process, not a fact about the space.",
    "- questions: everything you still need, as direct questions the owner can answer in one line each, most important first, at most 5. Always ask about any of these that was not stated: the price and what it is per; where it is (city or area) if the notes and profile city do not say; who sees it and roughly how many (people walking past per day, followers, or attendance); when it is available; and for a physical space, its rough size, what may go up on it, and who puts it up. Empty when nothing is missing. Do not ask about things already answered.",
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

function userText(body: Body) {
  return [
    body.image
      ? "Draft the listing for the space in this photo."
      : "Draft the listing from these notes.",
    body.notes ? `Owner's notes: ${body.notes}` : "The owner left no notes.",
    body.city ? `Owner's profile city: ${body.city}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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

/** Shared handling of the HTTP layer: both providers use the same codes. */
function checkHttp(provider: Provider, status: number, error: unknown) {
  if (status === 401 || status === 403) {
    console.error(`[listing draft] ${provider} rejected the API key`, error);
    throw new ApiError("Fill with AI is not set up correctly on this deployment.", 503);
  }
  if (status === 429 || status >= 500) {
    throw new ApiError("The drafting service is busy. Try again in a moment.", 503);
  }
  if (status !== 200) {
    console.error(`[listing draft] ${provider} returned`, status, error);
    throw new ApiError("SideSpace could not draft this listing right now.", 502);
  }
}

/* ------------------------------------------------------------------ Claude */

type AnthropicResponse = {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
};

async function anthropicRequest(apiKey: string, body: Body, withFallbacks: boolean) {
  const content: Array<Record<string, unknown>> = [];
  if (body.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: body.image },
    });
  }
  content.push({ type: "text", text: userText(body) });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  // Identity-linked keys (the console's newer default) are rejected with
  // "anthropic-workspace-id is required" unless the request names the
  // workspace it acts in. Workspace-scoped keys do not need it.
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  // Server-side fallback: if a safety classifier declines the request, the
  // API re-runs it on a suitable model inside the same call.
  if (withFallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 16000,
      system: systemPrompt(body.kind, body.city),
      messages: [{ role: "user", content }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: LISTING_DRAFT_SCHEMA },
      },
      ...(withFallbacks ? { fallbacks: "default" } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as AnthropicResponse;
  return { ...json, status: response.status };
}

async function draftWithAnthropic(apiKey: string, body: Body): Promise<string> {
  let result = await anthropicRequest(apiKey, body, true);
  // The fallback parameter is gated by a beta header. If this key or org
  // cannot use it, drop it and try once more rather than fail the draft.
  if (result.status === 400 && /fallback/i.test(result.error?.message ?? "")) {
    result = await anthropicRequest(apiKey, body, false);
  }
  if (result.status === 400 && /workspace|api key|api-key/i.test(result.error?.message ?? "")) {
    console.error("[listing draft] anthropic configuration error", result.error);
    throw new ApiError(
      "Fill with AI is not set up correctly on this deployment (Anthropic key needs a workspace id).",
      503,
    );
  }
  checkHttp("anthropic", result.status, result.error);

  if (result.stop_reason === "refusal") {
    throw new ApiError(
      "SideSpace could not draft from that. Try different notes or another photo.",
      422,
    );
  }
  if (result.stop_reason === "max_tokens") {
    throw new ApiError("The draft ran too long. Try shorter notes.", 502);
  }
  const text = result.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    console.error("[listing draft] anthropic returned no text", result.stop_reason);
    throw new ApiError("The draft came back empty. Try again.", 502);
  }
  return text;
}

/* ------------------------------------------------------------------ Gemini */

type GeminiResponse = {
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: number; message?: string; status?: string };
};

async function draftWithGemini(apiKey: string, body: Body): Promise<string> {
  const input: Array<Record<string, string>> = [];
  if (body.image) {
    input.push({ type: "image", data: body.image, mime_type: "image/jpeg" });
  }
  input.push({ type: "text", text: userText(body) });

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model: GEMINI_MODEL,
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
  checkHttp("gemini", response.status, json.error);

  const text = json.steps
    ?.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .find((part) => part.type === "text" && part.text)?.text;
  if (!text) {
    console.error("[listing draft] gemini returned no model output", json.status, json.error);
    throw new ApiError(
      "SideSpace could not draft from that. Try different notes or another photo.",
      422,
    );
  }
  return text;
}

/* ------------------------------------------------------------------- Route */

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const chosen = pickProvider();
    if (!chosen) {
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

    const text =
      chosen.provider === "anthropic"
        ? await draftWithAnthropic(chosen.apiKey, body)
        : await draftWithGemini(chosen.apiKey, body);

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
