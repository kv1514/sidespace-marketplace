/**
 * Whether this browser has signed in to SideSpace before.
 *
 * The account dialog has two faces, and picking the wrong one is a small
 * insult either way: a stranger asked to "sign in" has no credentials to give,
 * and a member asked to "create an account" is being told the site forgot
 * them. Supabase cannot settle it once a session ends — signing out wipes its
 * token, so a returning member and a first-time visitor look identical, and
 * every returning member was shown a sign-up form for an account they already
 * had.
 *
 * This is a UI hint and never an authorization signal. It asserts only that
 * SOMEONE signed in on this browser once, so the worst it can do is offer the
 * wrong form — which the dialog's own "New here? Create an account" toggle
 * undoes in a single press. Nothing here is trusted by the server, and no
 * session, token, or identity is stored.
 *
 * It deliberately SURVIVES sign-out. That is the entire point: the moment
 * worth remembering is the one right before someone comes back. It is cleared
 * in exactly one place — account deletion — because an account that no longer
 * exists must not greet its former owner with a sign-in form forever.
 *
 * Every call is wrapped. Safari in private mode throws on localStorage, and
 * nobody should meet an exception because a convenience failed.
 */

const RETURNING_KEY = "sidespace.returning";
const LAST_EMAIL_KEY = "sidespace.last-email";

function readStorage(key: string) {
  // `typeof window` rather than a browser check: this module is imported by
  // client components that Next still renders on the server, where reading
  // storage would make the two passes disagree about the first paint.
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode, or storage full. A friendlier default is not worth an
    // exception on a path that just succeeded at signing someone in.
  }
}

function dropStorage(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same reasoning as writeStorage.
  }
}

/**
 * Record that an account exists behind this browser.
 *
 * Called from every client-side moment that proves it, including the one that
 * creates no session at all: a sign-up awaiting email confirmation has made an
 * account even though no auth event will ever fire for it.
 *
 * The email is optional and is only ever used to prefill the sign-in field.
 * It is stored last so a storage failure cannot leave an address remembered
 * for a browser we did not manage to mark as returning.
 */
export function markReturningVisitor(email?: string | null) {
  writeStorage(RETURNING_KEY, "1");
  const address = email?.trim();
  if (address) writeStorage(LAST_EMAIL_KEY, address);
}

/**
 * True when the account dialog should open on "sign in" rather than "join".
 *
 * Read at click time, never during render. Per browser profile by nature: a
 * member on a new laptop, in a private window, or after clearing site data
 * reads as new, and a shared computer reads as whoever used it last. Both fall
 * back to offering sign-up, which is the harmless direction — the dialog can
 * still be switched by hand.
 */
export function hasReturnedBefore() {
  return readStorage(RETURNING_KEY) === "1";
}

/** The address to prefill on the sign-in form, if this browser remembers one. */
export function lastSignInEmail() {
  return readStorage(LAST_EMAIL_KEY) ?? "";
}

/**
 * Forget this browser.
 *
 * Deliberately NOT called on sign-out — surviving sign-out is the whole
 * purpose. This exists for account deletion, after which "Welcome back" and a
 * password field would be a dead end with no route left to sign up.
 */
export function forgetReturningVisitor() {
  dropStorage(RETURNING_KEY);
  dropStorage(LAST_EMAIL_KEY);
}
