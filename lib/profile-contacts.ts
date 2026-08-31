import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The private half of a member's profile.
 *
 * `public.profiles` carries a table-level SELECT grant for `anon`, because the
 * homepage embeds `listings -> profiles` and PostgREST cannot resolve that
 * embed without one. Column grants and definer views were both tried and both
 * fail there - see the 20260831 migration for the measurements. So the row
 * itself has to stay free of anything private, and these three fields live in
 * `profile_contacts`, which `anon` cannot read at all.
 *
 * Everything above the database keeps seeing one flat `Profile`: reads fold
 * the private fields back on, writes split them back out.
 */
export const PROFILE_CONTACT_COLUMNS =
  "contact_email,contact_name,business_preferences";

export type ProfileContactFields = {
  contact_email?: string | null;
  contact_name?: string | null;
  business_preferences?: unknown;
};

const CONTACT_KEYS = [
  "contact_email",
  "contact_name",
  "business_preferences",
] as const;

/**
 * Split a profile write into the public row and the private fields.
 *
 * Writing a private key to `profiles` would republish it to every anonymous
 * caller, so the split happens here rather than at each call site.
 */
export function splitProfileWrite<T extends Record<string, unknown>>(
  payload: T,
): { profile: Record<string, unknown>; contacts: ProfileContactFields } {
  const profile: Record<string, unknown> = {};
  const contacts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((CONTACT_KEYS as readonly string[]).includes(key)) contacts[key] = value;
    else profile[key] = value;
  }
  return { profile, contacts: contacts as ProfileContactFields };
}

/** Fold the private fields back onto a row read from `profiles`. */
export function withProfileContacts<T extends object>(
  profile: T,
  contacts: ProfileContactFields | null | undefined,
): T & ProfileContactFields {
  return {
    ...profile,
    contact_email: contacts?.contact_email ?? "",
    contact_name: contacts?.contact_name ?? "",
    business_preferences: contacts?.business_preferences ?? null,
  } as T & ProfileContactFields;
}

export async function loadProfileContacts(
  supabase: SupabaseClient,
  profileId: string,
): Promise<ProfileContactFields | null> {
  const { data } = await supabase
    .from("profile_contacts")
    .select(PROFILE_CONTACT_COLUMNS)
    .eq("profile_id", profileId)
    .maybeSingle();
  return (data as ProfileContactFields | null) ?? null;
}

/**
 * Upsert the private fields for one member.
 *
 * A key the caller did not set is left alone rather than nulled, so a partial
 * write - the campaign-preferences form, which touches one field - cannot wipe
 * the other two.
 */
export async function saveProfileContacts(
  supabase: SupabaseClient,
  profileId: string,
  contacts: ProfileContactFields,
) {
  const row: Record<string, unknown> = { profile_id: profileId };
  for (const key of CONTACT_KEYS) {
    if (contacts[key] !== undefined) row[key] = contacts[key] || null;
  }
  if (Object.keys(row).length === 1) return { error: null };
  return await supabase
    .from("profile_contacts")
    .upsert(row, { onConflict: "profile_id" });
}
