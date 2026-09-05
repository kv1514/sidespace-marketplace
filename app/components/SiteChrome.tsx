"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { LanguageSwitcher } from "@/app/components/LanguageSwitcher";
import { msg } from "@/lib/i18n";

export type SideSpaceRoute =
  | "home"
  | "marketplace"
  | "how-it-works"
  | "creators"
  | "pricing"
  | "dashboard";

type Viewer = {
  displayName: string;
  avatarUrl?: string;
};

const PUBLIC_LINKS: Array<{
  href: string;
  label: string;
  route: SideSpaceRoute;
}> = [
  { href: "/marketplace", label: msg("Marketplace"), route: "marketplace" },
  {
    href: "/marketplace?sort=popular",
    label: msg("Popular"),
    route: "marketplace",
  },
  { href: "/how-it-works", label: msg("How it works"), route: "how-it-works" },
  { href: "/creators", label: msg("Creators"), route: "creators" },
  { href: "/pricing", label: msg("Pricing"), route: "pricing" },
];

export function SideSpaceMark() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt=""
        aria-hidden="true"
        className="ss-brand-mark"
        width={31}
        height={31}
      />
      <span>SideSpace</span>
    </>
  );
}

export function SiteHeader({
  route,
  loading,
  viewer,
  unreadCount,
  onMessages,
  onSignIn,
  onJoin,
  onAccount,
}: {
  route: SideSpaceRoute;
  loading: boolean;
  viewer: Viewer | null;
  unreadCount: number;
  onMessages: () => void;
  onSignIn: () => void;
  onJoin: () => void;
  onAccount: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setScrolled(window.scrollY > 18);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    document.documentElement.classList.toggle("ss-nav-lock", menuOpen);
    return () => document.documentElement.classList.remove("ss-nav-lock");
  }, [menuOpen]);

  useEffect(() => {
    const desktopNav = window.matchMedia("(min-width: 1181px)");
    const closeOnDesktop = () => {
      if (desktopNav.matches) setMenuOpen(false);
    };
    desktopNav.addEventListener("change", closeOnDesktop);
    return () => desktopNav.removeEventListener("change", closeOnDesktop);
  }, []);

  const popularActive =
    route === "marketplace" &&
    typeof window !== "undefined" &&
    new URL(window.location.href).searchParams.get("sort") === "popular";

  return (
    <>
      <header
        className={`ss-header${scrolled ? " is-scrolled" : ""}${menuOpen ? " menu-open" : ""}`}
      >
        <div className="ss-header-inner">
        <Link className="ss-brand" href="/" aria-label={t("SideSpace home")}>
          <SideSpaceMark />
        </Link>

        <nav className="ss-desktop-nav" aria-label={t("Primary navigation")}>
          {PUBLIC_LINKS.map((link) => (
            <Link
              href={link.href}
              key={link.href}
              aria-current={
                route === link.route &&
                (link.href.includes("sort=popular") ? popularActive : !popularActive)
                  ? "page"
                  : undefined
              }
            >
              {t(link.label)}
            </Link>
          ))}
        </nav>

        <div className="ss-header-actions">
          {loading ? (
            <span className="ss-account-skeleton" aria-hidden="true" />
          ) : viewer ? (
            <>
              <button className="ss-header-text-action" onClick={onMessages}>
                {t("Messages")}
                {unreadCount > 0 && (
                  <b>{unreadCount > 99 ? "99+" : unreadCount}</b>
                )}
              </button>
              <Link
                className={`ss-header-text-action ss-dashboard-link${route === "dashboard" ? " is-current" : ""}`}
                href="/dashboard"
              >
                {t("Dashboard")}
              </Link>
              <button
                className="ss-profile-control"
                onClick={onAccount}
                aria-label={t("Open {displayName}'s profile and settings", { displayName: viewer.displayName })}
              >
                {viewer.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={viewer.avatarUrl} alt="" />
                ) : (
                  <span aria-hidden="true">
                    {viewer.displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span>{t("Profile")}</span>
              </button>
            </>
          ) : (
            <>
              <button className="ss-header-text-action ss-sign-in" onClick={onSignIn}>
                {t("Sign in")}
              </button>
              <button className="ss-header-join" onClick={onJoin}>
                <span>
                  {t("Join")}<span className="ss-header-join-full"> SideSpace</span>
                </span>
                <span aria-hidden="true" className="ss-icon-arrow">
                  ↗
                </span>
              </button>
            </>
          )}

          <button
            className="ss-menu-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="ss-mobile-menu"
            aria-label={menuOpen ? t("Close navigation") : t("Open navigation")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>

      <div className="ss-mobile-menu" id="ss-mobile-menu" hidden={!menuOpen}>
        <nav aria-label={t("Mobile navigation")}>
          {PUBLIC_LINKS.map((link, index) => (
            <Link
              href={link.href}
              key={link.href}
              aria-current={route === link.route ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {t(link.label)}
              <b aria-hidden="true" className="ss-icon-arrow">
                ↗
              </b>
            </Link>
          ))}
          {viewer && (
            <>
              <Link
                href="/dashboard"
                aria-current={route === "dashboard" ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                <span>05</span>
                {t("Dashboard")}
                <b aria-hidden="true" className="ss-icon-arrow">
                  ↗
                </b>
              </Link>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onMessages();
                }}
              >
                <span>06</span>
                {t("Messages")}
                {unreadCount > 0 && <b>{unreadCount}</b>}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onAccount();
                }}
              >
                <span>07</span>
                {t("Profile")}
                <b aria-hidden="true">↗</b>
              </button>
            </>
          )}
        </nav>
        <LanguageSwitcher className="ss-language-mobile" />
        {!viewer && (
          <div className="ss-mobile-auth">
            <button
              onClick={() => {
                setMenuOpen(false);
                onSignIn();
              }}
            >
              {t("Sign in")}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onJoin();
              }}
            >
              {t("Join SideSpace")}{" "}
              <span aria-hidden="true" className="ss-icon-arrow">
                ↗
              </span>
            </button>
          </div>
        )}
      </div>
    </header>
      {menuOpen && (
        <button
          aria-label={t("Close navigation")}
          className="ss-menu-backdrop"
          type="button"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

export function SiteFooter({ onJoin }: { onJoin: () => void }) {
  const t = useT();
  return (
    <footer className="ss-footer">
      <div className="ss-footer-lead">
        <Link className="ss-brand" href="/" aria-label={t("SideSpace home")}>
          <SideSpaceMark />
        </Link>
        <p>
          {t("The marketplace for local attention.")}
          <br />
          {t("Digital, physical, and directly bookable.")}
        </p>
      </div>
      <nav aria-label={t("Footer navigation")}>
        {PUBLIC_LINKS.map((link) => (
          <Link href={link.href} key={link.href}>
            {t(link.label)}
          </Link>
        ))}
        <Link href="/terms">{t("Terms")}</Link>
        <Link href="/privacy">{t("Privacy")}</Link>
      </nav>
      <div className="ss-footer-end">
        <button onClick={onJoin}>
          {t("List what you have")}{" "}
          <span aria-hidden="true" className="ss-icon-arrow">
            ↗
          </span>
        </button>
        <LanguageSwitcher />
        <small>{t("© {year} SideSpace", { year: new Date().getFullYear() })}</small>
      </div>
    </footer>
  );
}
