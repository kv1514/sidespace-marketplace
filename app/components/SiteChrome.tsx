"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  LanguageSwitcher,
  useLocale,
} from "@/app/components/LocaleProvider";
import type { TranslationKey } from "@/lib/i18n";

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
  labelKey: TranslationKey;
  route: SideSpaceRoute;
}> = [
  { href: "/marketplace", labelKey: "chrome.marketplace", route: "marketplace" },
  {
    href: "/marketplace?sort=popular",
    labelKey: "chrome.popular",
    route: "marketplace",
  },
  {
    href: "/how-it-works",
    labelKey: "chrome.howItWorks",
    route: "how-it-works",
  },
  { href: "/creators", labelKey: "chrome.creators", route: "creators" },
  { href: "/pricing", labelKey: "chrome.pricing", route: "pricing" },
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { t } = useLocale();

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
        <Link className="ss-brand" href="/" aria-label={t("chrome.sideSpaceHome")}>
          <SideSpaceMark />
        </Link>

        <nav className="ss-desktop-nav" aria-label={t("chrome.primaryNavigation")}>
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
              {t(link.labelKey)}
            </Link>
          ))}
        </nav>

        <div className="ss-header-actions">
          <div className="ss-language-switcher-desktop">
            <LanguageSwitcher />
          </div>
          {loading ? (
            <span className="ss-account-skeleton" aria-hidden="true" />
          ) : viewer ? (
            <>
              <button className="ss-header-text-action" onClick={onMessages}>
                {t("chrome.messages")}
                {unreadCount > 0 && (
                  <b>{unreadCount > 99 ? "99+" : unreadCount}</b>
                )}
              </button>
              <Link
                className={`ss-header-text-action ss-dashboard-link${route === "dashboard" ? " is-current" : ""}`}
                href="/dashboard"
              >
                {t("chrome.dashboard")}
              </Link>
              <button
                className="ss-profile-control"
                onClick={onAccount}
                aria-label={`${t("chrome.profile")}: ${viewer.displayName}`}
              >
                {viewer.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={viewer.avatarUrl} alt="" />
                ) : (
                  <span aria-hidden="true">
                    {viewer.displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span>{t("chrome.profile")}</span>
              </button>
            </>
          ) : (
            <>
              <button className="ss-header-text-action ss-sign-in" onClick={onSignIn}>
                {t("chrome.signIn")}
              </button>
              <button className="ss-header-join" onClick={onJoin}>
                <span>
                  {t("chrome.join")}<span className="ss-header-join-full"> SideSpace</span>
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
            aria-label={
              menuOpen ? t("chrome.closeNavigation") : t("chrome.openNavigation")
            }
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>

      <div className="ss-mobile-menu" id="ss-mobile-menu" hidden={!menuOpen}>
        <nav aria-label={t("chrome.mobileNavigation")}>
          {PUBLIC_LINKS.map((link, index) => (
            <Link
              href={link.href}
              key={link.href}
              aria-current={route === link.route ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {t(link.labelKey)}
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
                {t("chrome.dashboard")}
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
                {t("chrome.messages")}
                {unreadCount > 0 && <b>{unreadCount}</b>}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onAccount();
                }}
              >
                <span>07</span>
                {t("chrome.profile")}
                <b aria-hidden="true">↗</b>
              </button>
            </>
          )}
        </nav>
        <div className="ss-language-switcher-mobile">
          <LanguageSwitcher />
        </div>
        {!viewer && (
          <div className="ss-mobile-auth">
            <button
              onClick={() => {
                setMenuOpen(false);
                onSignIn();
              }}
            >
              {t("chrome.signIn")}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onJoin();
              }}
            >
              {t("chrome.joinSideSpace")} {" "}
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
          aria-label={t("chrome.closeNavigation")}
          className="ss-menu-backdrop"
          type="button"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

export function SiteFooter({ onJoin }: { onJoin: () => void }) {
  const { t } = useLocale();

  return (
    <footer className="ss-footer">
      <div className="ss-footer-lead">
        <Link className="ss-brand" href="/" aria-label={t("chrome.sideSpaceHome")}>
          <SideSpaceMark />
        </Link>
        <p>
          {t("chrome.footerTaglineOne")}
          <br />
          {t("chrome.footerTaglineTwo")}
        </p>
      </div>
      <nav aria-label={t("chrome.footerNavigation")}>
        {PUBLIC_LINKS.map((link) => (
          <Link href={link.href} key={link.href}>
            {t(link.labelKey)}
          </Link>
        ))}
        <Link href="/terms">{t("chrome.terms")}</Link>
        <Link href="/privacy">{t("chrome.privacy")}</Link>
      </nav>
      <div className="ss-footer-end">
        <button onClick={onJoin}>
          {t("chrome.listWhatYouHave")} {" "}
          <span aria-hidden="true" className="ss-icon-arrow">
            ↗
          </span>
        </button>
        <small>© {new Date().getFullYear()} SideSpace</small>
      </div>
    </footer>
  );
}
