import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  CountUp,
  HeroLine,
  Reveal,
  Stagger,
  StaggerItem,
} from "./motion-primitives";
import HeroCanvas from "./HeroCanvas";
import styles from "./preview.module.css";

export const metadata: Metadata = {
  title: "Design preview",
  description: "A candidate visual direction for SideSpace.",
  // A proposal, not the product: keep it out of search and out of the sitemap.
  robots: { index: false, follow: false },
};

export const revalidate = 300;

type Row = Record<string, unknown>;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

const STEPS = [
  {
    title: "List the space",
    body: "A window, a counter, a car door, a story on your feed. Add a photo and name your price.",
  },
  {
    title: "A business finds it",
    body: "Local businesses browse by channel and city, and send you a brief with dates and a budget.",
  },
  {
    title: "Agree the terms",
    body: "Accept, decline, or counter with a different number. Nothing is agreed until you say so.",
  },
  {
    title: "Run it",
    body: "You settle directly with the business. SideSpace takes no cut and holds no money.",
  },
];

const FEATURES = [
  {
    tag: "No minimum spend",
    title: "Priced for the block, not the brand",
    body: "Listings start at $2. The point is that a two-person bakery can afford to be seen this week.",
  },
  {
    tag: "You approve everything",
    title: "Nothing runs without your yes",
    body: "Every request needs your approval, and you can counter the price before anything is agreed.",
  },
  {
    tag: "Physical and digital",
    title: "One marketplace, both worlds",
    body: "A storefront window and an Instagram story sit side by side, because both are somewhere a neighbour will see you.",
  },
  {
    tag: "Pulled from the account",
    title: "Follower counts nobody rounds up",
    body: "Audience numbers come straight from the linked account, so what you see is what they have.",
  },
  {
    tag: "No broker",
    title: "You talk to each other",
    body: "Messages go directly between the business and the person who owns the space. No agency in the middle.",
  },
  {
    tag: "Free during early access",
    title: "No fees, no card",
    body: "Listing is free, browsing is free, and there is no commission while we are in early access.",
  },
];

const COMPARISON = [
  ["Getting started", "Call for a rate card, wait", "Post a listing in a minute"],
  ["Minimum spend", "Hundreds, often more", "$2"],
  ["Who you deal with", "An agency or an ad platform", "The person who owns the space"],
  ["Setting the price", "Take the rate you are given", "You name it, and you can counter"],
  ["Local reach", "Sold by postcode, roughly", "A specific window on a specific street"],
  ["Cost to list", "Not an option for most spaces", "Free"],
];

export default async function PreviewPage() {
  let profiles: Row[] = [];
  let listings: Row[] = [];

  try {
    const supabase = await createClient();
    const [profilesResult, listingsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false })
        .limit(60),
      supabase
        .from("listings")
        .select("*, owner:profiles!listings_owner_profile_id_fkey(*)")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    profiles = profilesResult.error ? [] : ((profilesResult.data as Row[]) ?? []);
    listings = listingsResult.error ? [] : ((listingsResult.data as Row[]) ?? []);
  } catch {
    // Supabase unreachable at build or request time: render the frame with no
    // rows rather than failing the route.
    profiles = [];
    listings = [];
  }

  // Test and support accounts are real rows that must never be shown as members.
  const real = profiles.filter((p) => !p.is_internal);
  const realListings = listings.filter((l) => {
    const owner = l.owner as Row | null;
    return owner && !owner.is_internal;
  });

  const prices = realListings
    .map((l) => Number(l.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const cheapest = prices.length ? Math.min(...prices) : 2;

  const channels = Array.from(
    new Set(realListings.map((l) => String(l.channel)).filter(Boolean)),
  );

  const shown = realListings.slice(0, 9);
  const members = real
    .slice()
    .sort((a, b) => Number(b.followers ?? 0) - Number(a.followers ?? 0))
    .slice(0, 8);

  return (
    <div className={styles.shell}>
      <p className={styles.ribbon}>
        Design preview, not the live site.{" "}
        <Link href="/">Back to SideSpace</Link>
      </p>

      <nav className={styles.nav}>
        <Link className={styles.mark} href="/preview">
          <span className={styles.markGlyph}>S</span> SideSpace
        </Link>
        <div className={styles.navLinks}>
          <a href="#how">How it works</a>
          <a href="#why">Why SideSpace</a>
          <a href="#market">Marketplace</a>
          <a href="#members">Members</a>
        </div>
        <Link className={styles.btn} href="/">
          Join SideSpace
        </Link>
      </nav>

      <div className={styles.heroWrap}>
        <div className={styles.heroCanvas}>
          <HeroCanvas />
        </div>

        <header className={styles.hero}>
          <HeroLine>
            <p className={styles.eyebrow}>
              <span className={styles.eyebrowDot} />
              {realListings.length} listings live, Southern California, free
              during early access
            </p>
          </HeroLine>

          <HeroLine delay={0.08}>
            <h1 className={styles.heroTitle}>
              Every space
              <br />
              has an audience.
            </h1>
          </HeroLine>

          <HeroLine delay={0.16}>
            <p className={styles.lede}>
              SideSpace is a marketplace for the advertising space already
              around you, a cafe window, a car door, a club hoodie, a story on
              someone&apos;s feed. Local businesses book it directly from the
              person who owns it.
            </p>
          </HeroLine>

          <HeroLine delay={0.24}>
            <div className={styles.heroCta}>
              <Link className={`${styles.btn} ${styles.btnAccent}`} href="/">
                List your space
              </Link>
              <a className={`${styles.btn} ${styles.btnGhost}`} href="#market">
                Browse the marketplace
              </a>
            </div>
          </HeroLine>

          <HeroLine delay={0.32}>
            <div className={styles.heroNotes}>
              <span>No broker</span>
              <span>No minimum spend</span>
              <span>From ${cheapest}</span>
            </div>
          </HeroLine>
        </header>
      </div>

      <div className={styles.marquee} aria-hidden="true">
        {/* Two identical tracks so the -50% loop has no seam. */}
        <div className={styles.marqueeTrack}>
          {[...channels, ...channels].map((channel, index) => (
            <span className={styles.marqueeItem} key={`${channel}-${index}`}>
              {channel}
            </span>
          ))}
        </div>
      </div>

      <Reveal>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <CountUp className={styles.statValue} value={realListings.length} />
            <span className={styles.statLabel}>Listings live</span>
          </div>
          <div className={styles.stat}>
            <CountUp className={styles.statValue} value={real.length} />
            <span className={styles.statLabel}>Members</span>
          </div>
          <div className={styles.stat}>
            <CountUp className={styles.statValue} value={cheapest} prefix="$" />
            <span className={styles.statLabel}>Cheapest slot</span>
          </div>
          <div className={styles.stat}>
            <CountUp className={styles.statValue} value={channels.length} />
            <span className={styles.statLabel}>Kinds of space</span>
          </div>
        </div>
      </Reveal>

      <section className={styles.section} id="how">
        <Reveal>
          <p className={styles.eyebrow}>Process</p>
          <h2 className={styles.sectionHead}>
            From a window to a booking
            <br />
            in four steps.
          </h2>
          <p className={styles.sectionSub}>
            No agency, no rate card, no minimum. You keep control of the price
            and of who runs on your space.
          </p>
        </Reveal>

        <Stagger className={styles.steps}>
          {STEPS.map((step, index) => (
            <StaggerItem className={styles.step} key={step.title}>
              <span className={styles.stepNo}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      <section className={styles.section} id="why">
        <Reveal>
          <p className={styles.eyebrow}>Why SideSpace</p>
          <h2 className={styles.sectionHead}>
            Everything a small business
            <br />
            actually needs.
          </h2>
          <p className={styles.sectionSub}>
            Paid advertising is priced for companies much bigger than the ones
            that need it most. This is the version that fits a single street.
          </p>
        </Reveal>

        <Stagger className={styles.featureGrid}>
          {FEATURES.map((feature) => (
            <StaggerItem className={styles.feature} key={feature.title}>
              <span className={styles.featureTag}>{feature.tag}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      <section className={styles.section} id="market">
        <Reveal>
          <p className={styles.eyebrow}>Marketplace</p>
          <h2 className={styles.sectionHead}>
            Real listings, posted
            <br />
            by real neighbours.
          </h2>
          <p className={styles.sectionSub}>
            Everything below is live on SideSpace right now, with the price the
            owner set.
          </p>
        </Reveal>

        <Stagger className={styles.grid}>
          {shown.map((listing) => {
            const owner = listing.owner as Row;
            const name = String(owner.display_name ?? "Member");
            return (
              <StaggerItem className={styles.card} key={String(listing.id)}>
                <div className={styles.cardTop}>
                  <span className={styles.tag}>{String(listing.channel)}</span>
                  <span className={styles.price}>${String(listing.price)}</span>
                </div>
                <h3>{String(listing.title)}</h3>
                <p>{String(listing.description ?? "").slice(0, 110)}</p>
                <div className={styles.by}>
                  <span className={styles.avatar}>{initials(name)}</span>
                  <span>
                    {name}
                    {owner.city ? `, ${String(owner.city)}` : ""}
                  </span>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>

      <section className={styles.section} id="members">
        <Reveal>
          <p className={styles.eyebrow}>Members</p>
          <h2 className={styles.sectionHead}>
            Hosts and businesses,
            <br />
            side by side.
          </h2>
          <p className={styles.sectionSub}>
            Follower counts come straight from the linked account, so nobody
            gets to round up.
          </p>
        </Reveal>

        <Stagger className={styles.memberRow}>
          {members.map((person) => {
            const name = String(person.display_name ?? "Member");
            const followers = Number(person.followers ?? 0);
            return (
              <StaggerItem className={styles.member} key={String(person.id)}>
                <span className={styles.avatar}>{initials(name)}</span>
                <span className={styles.memberName}>{name}</span>
                {person.instagram ? (
                  <span className={styles.handle}>
                    @{String(person.instagram).replace(/^@/, "")}
                  </span>
                ) : null}
                <span className={styles.meta}>
                  {followers > 0
                    ? `${followers.toLocaleString("en")} followers`
                    : String(person.role ?? "Member")}
                </span>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>

      <section className={styles.section}>
        <Reveal>
          <p className={styles.eyebrow}>Before and after</p>
          <h2 className={styles.sectionHead}>
            Local advertising, the old
            <br />
            way and this way.
          </h2>
        </Reveal>

        <Reveal delay={0.08}>
          <div className={styles.compare}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  <th scope="col">Traditional</th>
                  <th scope="col">
                    SideSpace <span className={styles.star}>✦</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map(([area, before, after]) => (
                  <tr key={area}>
                    <th scope="row">{area}</th>
                    <td>{before}</td>
                    <td className={styles.ours}>{after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>

      <div className={styles.cta}>
        <Reveal>
          <h2 className={styles.ctaTitle}>
            Ready to rent out
            <br />
            your side space?
          </h2>
          <p className={styles.lede}>
            Free to list, free to browse, and you approve everything before it
            runs.
          </p>
          <div className={styles.heroCta}>
            <Link className={`${styles.btn} ${styles.btnAccent}`} href="/">
              Create a free account
            </Link>
          </div>
        </Reveal>
      </div>

      <footer className={styles.footer}>
        Made in Brea by Kausthubh and Jeff, SideSpace 2026
      </footer>
    </div>
  );
}
