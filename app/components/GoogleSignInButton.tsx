"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Google sign-in that happens on our own domain.
 *
 * The redirect flow hands the whole round trip to Supabase, and Google names
 * whoever owns the redirect it is sending people back to. That made the first
 * screen a new member ever sees read "to continue to
 * jlomjbixyemqsruycycz.supabase.co" - a random string nobody recognises, on
 * the one screen where a stranger decides whether we are trustworthy. No
 * setting moves SideSpace into that sentence; the only way is to stop routing
 * people through somebody else's domain.
 *
 * Google Identity Services runs on this page and hands back an ID token, which
 * Supabase trades for exactly the same session. Same client id, so the same
 * Google account resolves to the same existing user - nobody's account splits
 * in two. Google names this page instead.
 *
 * Everything here is optional. No client id, a blocked script, a refused
 * token: `fallback` takes over and the old redirect still signs people in.
 * Sign-in never depends on this working.
 */

type CredentialResponse = { credential: string };

type GoogleIdentity = {
  accounts?: {
    id?: {
      initialize: (config: {
        client_id: string;
        callback: (response: CredentialResponse) => void;
        nonce?: string;
        auto_select?: boolean;
        cancel_on_tap_outside?: boolean;
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: Record<string, string | number>,
      ) => void;
    };
  };
};

/**
 * One script tag per page, however many buttons ask for it.
 *
 * Kept at module scope rather than in the component: the auth dialog mounts
 * and unmounts every time it is opened, and re-appending the tag on each open
 * would leave Google re-initialising against a stale callback.
 */
let identityScript: Promise<void> | null = null;

function loadGoogleIdentity() {
  if (identityScript) return identityScript;
  identityScript = new Promise<void>((resolve, reject) => {
    const src = "https://accounts.google.com/gsi/client";
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`,
    );
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Google Identity Services failed to load")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () =>
      reject(new Error("Google Identity Services failed to load")),
    );
    document.head.appendChild(script);
  });
  return identityScript;
}

/**
 * A nonce in both the shapes the exchange needs.
 *
 * Google is handed the SHA-256 of the value, hex encoded, and stamps that into
 * the token. Supabase is handed the raw string and hashes it the same way to
 * check the two agree. Sending the same value to both fails verification, so
 * they are generated together and never separated.
 */
async function signInNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  const hashed = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { raw, hashed };
}

export default function GoogleSignInButton({
  clientId,
  onCredential,
  fallback,
}: {
  /** Public by nature - it travels in the URL of every OAuth round trip. */
  clientId: string;
  /** The ID token, and the raw nonce Supabase needs to verify it. */
  onCredential: (token: string, nonce: string) => void;
  /** Shown instead whenever the token path is unavailable. */
  fallback: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so a new closure from the parent's re-render does not
  // tear down and re-render Google's button mid sign-in.
  const onCredentialRef = useRef(onCredential);
  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  // null while we find out, so neither button flashes up and is replaced.
  const [available, setAvailable] = useState<boolean | null>(
    clientId ? null : false,
  );

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;

    void (async () => {
      try {
        await loadGoogleIdentity();
        const { raw, hashed } = await signInNonce();
        const host = hostRef.current;
        if (cancelled || !host) return;
        const identity = (window as unknown as { google?: GoogleIdentity })
          .google;
        if (!identity?.accounts?.id) {
          throw new Error("Google Identity Services did not define itself");
        }
        identity.accounts.id.initialize({
          client_id: clientId,
          nonce: hashed,
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: (response) => {
            if (response?.credential) {
              onCredentialRef.current(response.credential, raw);
            }
          },
        });
        host.replaceChildren();
        // Google's button takes a pixel width, not a percentage, and its own
        // ceiling is 400. Measured from the slot so it fills the dialog on a
        // phone instead of hanging 20px off each side of a 280px card.
        const width = Math.round(
          Math.min(400, Math.max(200, host.clientWidth || 320)),
        );
        identity.accounts.id.renderButton(host, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width,
        });
        if (!cancelled) setAvailable(true);
      } catch (error) {
        // Not a toast: the redirect below still signs people in, so this is
        // ours to notice, not theirs. It is the one place that says why the
        // Google screen went back to naming Supabase.
        console.error(
          "[google sign-in] on-domain token path unavailable, using the redirect flow:",
          error,
        );
        if (!cancelled) setAvailable(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (available === false) return <>{fallback}</>;
  // Space is held while Google's button loads so the dialog does not jump.
  return <div className="google-identity" ref={hostRef} aria-busy={available === null} />;
}
