import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import Motion from "./Motion";
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
        Design preview · not the live site ·{" "}
        <Link href="/">back to SideSpace</Link>
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

      <header className={styles.hero}>
        <p className={`${styles.eyebrow} ${styles.heroLine}`}>
          <span className={styles.eyebrowDot} />
          {realListings.length} listings live · Southern California · Free during
          early access
        </p>
        <h1 className={`${styles.heroLine} ${styles.heroDelay1}`}>
          Every space
          <br />
          has an audience.
        </h1>
        <p className={`${styles.lede} ${styles.heroLine} ${styles.heroDelay2}`}>
          SideSpace is a marketplace for the advertising space already around
          you, a cafe window, a car door, a club hoodie, a story on someone&apos;s
          feed. Local businesses book it directly from the person who owns it.
        </p>
        <div className={`${styles.heroCta} ${styles.heroLine} ${styles.heroDelay3}`}>
          <Link className={styles.btn} href="/">
            List your space
          </Link>
          <a className={`${styles.btn} ${styles.btnGhost}`} href="#market">
            Browse the marketplace
          </a>
        </div>
        <div className={`${styles.heroNotes} ${styles.heroLine} ${styles.heroDelay4}`}>
          <span>No broker</span>
          <span>No minimum spend</span>
          <span>From ${cheapest}</span>
        </div>
      </header>

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

      <div className={styles.stats} data-reveal>
        <div className={styles.stat}>
          <b data-count={realListings.length}>{realListings.length}</b>
          <span>Listings live</span>
        </div>
        <div className={styles.stat}>
          <b data-count={real.length}>{real.length}</b>
          <span>Members</span>
        </div>
        <div className={styles.stat}>
          <b data-count={cheapest} data-count-prefix="$">
            ${cheapest}
          </b>
          <span>Cheapest slot</span>
        </div>
        <div className={styles.stat}>
          <b data-count={channels.length}>{channels.length}</b>
          <span>Kinds of space</span>
        </div>
      </div>

      <section className={styles.section} id="how">
        <p data-reveal className={styles.eyebrow}>Process</p>
        <h2 className={styles.sectionHead} data-reveal>
          From a window to a booking
          <br />
          in four steps.
        </h2>
        <p className={styles.sectionSub} data-reveal>
          No agency, no rate card, no minimum. You keep control of the price and
          of who runs on your space.
        </p>
        <div className={styles.steps}>
          {STEPS.map((step, index) => (
            <div
              className={styles.step}
              key={step.title}
              data-reveal
              data-reveal-delay={index * 70}
            >
              <span className={styles.stepNo}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} id="why">
        <p data-reveal className={styles.eyebrow}>Why SideSpace</p>
        <h2 className={styles.sectionHead} data-reveal>
          Everything a small business
          <br />
          actually needs.
        </h2>
        <p className={styles.sectionSub} data-reveal>
          Paid advertising is priced for companies much bigger than the ones that
          need it most. This is the version that fits a single street.
        </p>
        <div className={styles.featureGrid}>
          {FEATURES.map((feature, index) => (
            <article
              className={styles.feature}
              key={feature.title}
              data-reveal
              data-reveal-delay={index * 60}
            >
              <span className={styles.featureTag}>{feature.tag}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} id="market">
        <p data-reveal className={styles.eyebrow}>Marketplace</p>
        <h2 className={styles.sectionHead} data-reveal>
          Real listings, posted
          <br />
          by real neighbours.
        </h2>
        <p className={styles.sectionSub} data-reveal>
          Everything below is live on SideSpace right now, with the price the
          owner set.
        </p>
        <div className={styles.grid}>
          {shown.map((listing, index) => {
            const owner = listing.owner as Row;
            const name = String(owner.display_name ?? "Member");
            return (
              <article
                className={styles.card}
                key={String(listing.id)}
                data-reveal
                data-reveal-delay={(index % 3) * 70}
              >
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
                    {owner.city ? ` · ${String(owner.city)}` : ""}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.section} id="members">
        <p data-reveal className={styles.eyebrow}>Members</p>
        <h2 className={styles.sectionHead} data-reveal>
          Hosts and businesses,
          <br />
          side by side.
        </h2>
        <p className={styles.sectionSub} data-reveal>
          Follower counts come straight from the linked account, so nobody gets
          to round up.
        </p>
        <div className={styles.memberRow}>
          {members.map((person, index) => {
            const name = String(person.display_name ?? "Member");
            const followers = Number(person.followers ?? 0);
            return (
              <div
                className={styles.member}
                key={String(person.id)}
                data-reveal
                data-reveal-delay={(index % 4) * 60}
              >
                <span className={styles.avatar}>{initials(name)}</span>
                <b>{name}</b>
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
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <p data-reveal className={styles.eyebrow}>Before &amp; after</p>
        <h2 className={styles.sectionHead} data-reveal>
          Local advertising, the old
          <br />
          way and this way.
        </h2>
        <div className={styles.compare} data-reveal>
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
      </section>

      <div className={styles.cta}>
        <h2 data-reveal>
          Ready to rent out
          <br />
          your side space?
        </h2>
        <p className={styles.lede}>
          Free to list, free to browse, and you approve everything before it runs.
        </p>
        <div className={styles.heroCta}>
          <Link className={styles.btn} href="/">
            Create a free account
          </Link>
        </div>
      </div>

      <footer className={styles.footer}>
        Made in Brea by Kausthubh &amp; Jeff · SideSpace 2026
      </footer>

      <Motion />
    </div>
  );
}
