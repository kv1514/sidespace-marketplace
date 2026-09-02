import { ApiError } from "@/lib/payments/request";
import { claimBudget, requireMember, sameOrigin } from "@/lib/listings/member";
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
 *
 * Evidence: the owner's notes, the owner's photo, and (physical spaces with an
 * exact address) a Google Street View frame for the surroundings. The prompt
 * holds the model to those three; the form shows back what it says it saw.
 *
 * Voice: browsers with built-in speech recognition send words. The rest
 * (Firefox, Brave, in-app browsers, or a recogniser that failed) send a short
 * recording, which Gemini transcribes before the draft - Claude does not take
 * audio - so a recording needs GEMINI_API_KEY even when Claude writes the
 * draft.
 */

const ANTHROPIC_MODEL = "claude-opus-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** ~2 MB decoded. The form re-encodes photos to ~300 KB JPEG before sending. */
const MAX_IMAGE_BASE64 = 2_800_000;
/** Typed notes plus a transcript; a minute of talking is ~150 words. */
const MAX_NOTES = 1200;
/** ~2.2 MB decoded: a minute of speech is a few hundred KB as Opus, ~1 MB as AAC. */
const MAX_AUDIO_BASE64 = 3_000_000;
/**
 * What browsers record, mapped to what Gemini lists as readable. Safari's
 * MediaRecorder labels its AAC-in-MP4 output audio/mp4; m4a is that container.
 */
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/opus",
  "audio/mp4": "audio/m4a",
  "audio/m4a": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
  "audio/wav": "audio/wav",
};
const DRAFTS_PER_HOUR = 20;
/** Form fields the browser sends back on a second Fill, so the model improves rather than restarts. */
const CURRENT_FIELDS = new Set([
  "title",
  "format",
  "description",
  "demographics",
  "space_size",
  "availability_notes",
  "minimum_booking",
  "deliverables",
]);

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
    `This listing is ${what}. Write it in the owner's voice, first person, like a sharp copywriter for a local marketplace: confident, concrete, benefit-led. Lead with the strongest fact. Turn every fact the owner gave into a reason a buyer would want the spot - where it sits becomes who passes it, a number becomes reach, timing becomes when the ad works. Specific beats general; short sentences beat long ones. No exclamation marks, no emoji, no clichés ("perfect opportunity", "don't miss out", "great exposure"), and never mention AI.`,
    "",
    "EVIDENCE. You have up to three sources: the owner's notes, the owner's photo of the space, and sometimes a Google Street View frame of the address. Every claim must come from one of them. From the owner's photo you may state what is plainly visible: the surface and what it is made of, its setting (a glass door, a brick wall, a corridor, a counter, a window onto a street), what stands right beside it, its rough size only against a visible reference such as a door or a person, and activity actually in frame. The Street View frame shows the street outside as it was when the camera car passed, possibly years ago: use it for surroundings only (a corner, a bus stop, a crossing, the shops either side), never for the current state of the space, and never let it override the owner's photo or notes. NEVER infer, estimate, round up, or invent: not a price, not a size, not a foot-traffic, follower, or attendance number, not an address, not an availability window, not who installs, not what is nearby unless a photo or the notes show it. If a fact is not stated or shown, leave the field empty (null for price) and ask for it in questions. A blank the owner fills is right; a number you made up is a failure.",
    "",
    "SECOND PASS. When the message includes the current draft, the owner has already seen a version and may have edited it or typed answers straight into the fields. Keep every fact and every specific phrase they kept, fold in the new answers, tighten weak sentences, and fill only what is still blank. Never drop information that was there, and never re-ask what the current draft or the notes already answer.",
    "",
    "Field rules:",
    "- title: at most 9 words, specific and appealing: the space plus its best locator. Examples: \"Dorm door by the 4th-floor stairwell, Blackwell\", \"Cafe window, Main Street\".",
    "- channel: for a physical space, the closest of Storefront, Vehicle, Wall / mural, Room / interior, Community board. A door, hallway, or room is Room / interior. Use Other only when none fits.",
    "- format: finishes the sentence \"You get ...\" exactly as it should read on the card. Example: \"one letter-size poster in my front window for a week\". Only when the owner said what they are offering - what goes up and for how long; otherwise empty, and ask.",
    "- description: three to five sentences a buyer reads as-is, built only from the evidence. Open with what it is and exactly where. Then who passes or sees it and why that audience matters to an advertiser. Then what goes up, how, and what the owner handles. Make the reader picture their ad there: name what they would see, from the photo - the surface, its setting, what stands beside it. Every sentence must carry a fact; cut any that only sounds good. If the owner gave little, keep it short and let questions do the asking - never pad, never invent. Never write placeholders or refer to missing details (no \"details below\", no \"once I fill this in\"). Use the owner's own words for what the ad is; do not rename or upgrade a feature (a \"link\" stays a link). Do not state the price in the description - the listing shows the price separately, prices change, and SideSpace's floor is $2 so a lower stated price is adjusted; prose that repeats it goes wrong.",
    "- demographics: only what the owner said about who sees it and how many. Empty when they said nothing.",
    `- location_area: the city or area from the notes${city ? `, otherwise "${city}"` : ""}. Never a street address.`,
    "- space_size: only when the owner stated it, or the photo shows it against a visible reference (a standard door, a person, a sheet of paper) - then say it is approximate; otherwise empty.",
    "- surface_types: what the owner said may go up, and nothing more (\"flyers welcome\" means Flyers, not Flyers and Posters). Only when they said nothing at all, the one or two things that plausibly fit the surface. Empty for anything that is not a physical surface.",
    "- install_by: \"owner\", \"renter\", or \"either\" only if the notes say who puts the ad up; otherwise an empty string.",
    "- price_dollars: only the price the owner stated, in whole US dollars. null when they did not say. Never suggest one.",
    `- price_unit: ${kind === "physical" ? '"week" unless the notes say otherwise' : kind === "sponsorship" ? '"campaign" for a season, event, or match run; "sponsor" only for a per-sponsor tier' : '"post", "story", or "video" to match the format'}.`,
    "- minimum_booking and availability_notes: from the notes, otherwise empty.",
    "- deliverables: the proof handed back after booking, one or two sentences. For a physical space, a photo of the ad in place. This one may be drafted; it describes the process, not a fact about the space.",
    "- questions: everything you still need, as direct questions the owner can answer in one line each, most important first, at most 5. Always ask about any of these that was not stated: the price and what it is per; where it is (city or area) if the notes and profile city do not say; who sees it and roughly how many (people walking past per day, followers, or attendance); when it is available; and for a physical space, its rough size, what may go up on it, and who puts it up. Empty when nothing is missing. Do not ask about things already answered.",
    "- photo_observations: up to six short, plain facts you can see in the owner's photo, one each (\"a wooden door with a wire-mesh window\", \"a corridor with about six doors\", \"a bulletin board with three flyers on it\"). Only what is visible: no judgements, no guesses about what is out of frame, nothing from the Street View frame. Empty when there is no owner's photo. The owner checks this list, so a wrong item is worse than a missing one.",
    "",
    "The standard, from one owner's notes: \"dorm door, 4th floor of Blackwell, corner by the emergency stairs, flyers ok, I put them up, $1 a week, available now\".",
    "Weak: \"This is the door to my dorm room on the fourth floor. It is near the stairs. People walk past it.\"",
    "Strong: \"My dorm door sits at the corner of Blackwell's fourth floor, right beside the emergency stairwell - so every resident who skips the elevator walks straight past it, on top of everyone who lives on the floor. It takes a standard flyer, I put it up myself, and it's open now.\"",
    "Every claim in the strong version comes from the notes. Nothing was added. Write at that standard.",
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

function userText(body: Body) {
  const parts = [
    body.image && body.streetImage
      ? "Two images: the first is the owner's photo of the space, the second is a Google Street View frame of the address (surroundings only, possibly out of date). Draft the listing."
      : body.image
        ? "Draft the listing for the space in this photo."
        : body.streetImage
          ? "The image is a Google Street View frame of the address (surroundings only, possibly out of date); the owner has not added a photo of the space itself. Draft the listing."
          : "Draft the listing from these notes.",
    body.notes ? `Owner's notes: ${body.notes}` : "The owner left no notes.",
    body.city ? `Owner's profile city: ${body.city}` : "",
  ];
  if (body.current) {
    parts.push("Current draft in the form (second pass - keep what the owner kept):");
    for (const [field, value] of Object.entries(body.current)) {
      parts.push(`${field}: ${value}`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

type Body = {
  kind: ListingDraftKind;
  notes: string;
  /** The owner's own photo of the space, JPEG base64. */
  image: string | null;
  /** A Google Street View frame of the address, JPEG base64: surroundings only. */
  streetImage: string | null;
  audio: { data: string; mimeType: string } | null;
  /** What the form holds now, on a second Fill. */
  current: Record<string, string> | null;
  city: string;
};

function readImage(value: unknown, unreadable: string) {
  const image = typeof value === "string" ? value.trim() : "";
  if (!image) return null;
  if (image.length > MAX_IMAGE_BASE64) {
    throw new ApiError("That photo is too large to draft from. Try a smaller one.", 413);
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(image)) throw new ApiError(unreadable);
  return image;
}

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
  const image = readImage(raw.image, "That photo could not be read.");
  const streetImage = readImage(raw.street_image, "That Street View frame could not be read.");
  let current: Body["current"] = null;
  if (raw.current && typeof raw.current === "object") {
    const entries = Object.entries(raw.current as Record<string, unknown>)
      .filter(([field, value]) => CURRENT_FIELDS.has(field) && typeof value === "string" && value.trim())
      .map(([field, value]) => [field, String(value).trim().slice(0, 2000)] as const);
    if (entries.length) current = Object.fromEntries(entries);
  }
  let audio: Body["audio"] = null;
  if (raw.audio && typeof raw.audio === "object") {
    const clip = raw.audio as Record<string, unknown>;
    const data = typeof clip.data === "string" ? clip.data.trim() : "";
    const label =
      typeof clip.mime_type === "string"
        ? clip.mime_type.split(";")[0].trim().toLowerCase()
        : "";
    if (data) {
      if (data.length > MAX_AUDIO_BASE64) {
        throw new ApiError("That recording is too long to draft from. Keep it under a minute.", 413);
      }
      if (!/^[A-Za-z0-9+/]+=*$/.test(data)) {
        throw new ApiError("That recording could not be read.");
      }
      const mimeType = AUDIO_TYPES[label];
      if (!mimeType) {
        throw new ApiError(
          "That recording is in a format SideSpace cannot read. Type a few words instead.",
          415,
        );
      }
      audio = { data, mimeType };
    }
  }
  if (!image && !notes && !audio && !streetImage) {
    throw new ApiError("Add a photo or a few words first, then press Fill with AI.");
  }
  const city = typeof raw.city === "string" ? raw.city.trim().slice(0, 80) : "";
  return { kind, notes, image, streetImage, audio, current, city };
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
  for (const data of [body.image, body.streetImage]) {
    if (data) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data },
      });
    }
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
        // Writing quality is the product here; a notch more thinking is
        // worth the few extra cents a draft.
        effort: "high",
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
  for (const data of [body.image, body.streetImage]) {
    if (data) input.push({ type: "image", data, mime_type: "image/jpeg" });
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

  const text = geminiText(json);
  if (!text) {
    console.error("[listing draft] gemini returned no model output", json.status, json.error);
    throw new ApiError(
      "SideSpace could not draft from that. Try different notes or another photo.",
      422,
    );
  }
  return text;
}

function geminiText(json: GeminiResponse) {
  return json.steps
    ?.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .find((part) => part.type === "text" && part.text)?.text;
}

/**
 * Turn a recording into words. Runs before the draft whichever provider
 * writes it, so the member sees what was heard in the notes box and can fix
 * it before filling again.
 */
async function transcribeWithGemini(
  apiKey: string,
  audio: NonNullable<Body["audio"]>,
): Promise<string> {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: [
        "You transcribe a voice note in which someone describes an advertising space they want to rent out: what and where it is, who sees it, the price, when it is available.",
        "Write down what is said, in the speaker's language, as plain text. Drop filler (um, uh, like, you know) and false starts; keep every fact and number. Numbers as digits, prices with a dollar sign.",
        "Do not summarise, answer, comment, or add anything. If there is no speech, reply with an empty string.",
      ].join(" "),
      input: [
        { type: "audio", data: audio.data, mime_type: audio.mimeType },
        { type: "text", text: "Transcribe this recording." },
      ],
      generation_config: { thinking_level: "low" },
    }),
  });
  const json = (await response.json().catch(() => ({}))) as GeminiResponse;
  checkHttp("gemini", response.status, json.error);
  return (geminiText(json) ?? "").trim().slice(0, MAX_NOTES);
}

/* ------------------------------------------------------------------- Route */

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const chosen = pickProvider();
    if (!chosen) {
      throw new ApiError("Fill with AI is not set up on this deployment yet.", 503);
    }
    const { profile, admin } = await requireMember("Sign in to draft a listing.");
    await claimBudget(
      admin,
      "listing_draft",
      profile.id,
      DRAFTS_PER_HOUR,
      3600,
      "That is plenty of drafts for one hour. Edit what you have, or try again later.",
    );

    const body = await readBody(request);
    if (!body.city && profile.city) body.city = String(profile.city);

    const startedAt = Date.now();
    let transcript = "";
    if (body.audio) {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        console.error(
          "[listing draft] a recording arrived but GEMINI_API_KEY is not set; voice recordings need it",
        );
        throw new ApiError(
          "Voice recordings are not switched on here yet. Type a few words instead, or use Chrome or Safari, which understand speech on their own.",
          503,
        );
      }
      transcript = await transcribeWithGemini(geminiKey, body.audio);
      if (!transcript) {
        throw new ApiError(
          "Nothing was heard in that recording. Check the microphone and try again, or type a few words.",
          422,
        );
      }
      body.notes = [body.notes, transcript].filter(Boolean).join(" ").slice(0, MAX_NOTES);
    }
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

    // One line per successful draft. Until now only failures were logged, so
    // confirming that a tap worked meant reading status codes; this names the
    // provider, whether a photo was sent, how many questions came back, and
    // how long it took. No member data.
    console.info(
      `[listing draft] ok provider=${chosen.provider} kind=${body.kind} photo=${body.image ? "yes" : "no"} street=${body.streetImage ? "yes" : "no"} refill=${body.current ? "yes" : "no"} audio=${body.audio ? "yes" : "no"} questions=${draft.questions.length} ms=${Date.now() - startedAt}`,
    );

    return Response.json(
      { draft, transcript },
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
