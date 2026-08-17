import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What SideSpace collects, why, and what stays private.",
};

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <Link className="legal-home" href="/">
        ← SideSpace
      </Link>
      <h1>Privacy Policy</h1>
      <p className="legal-updated">Last updated: August 16, 2026</p>

      <h2>1. What we collect</h2>
      <ul>
        <li>
          <strong>Account details.</strong> Your name, email address, and a
          password. Passwords are handled by Supabase Auth and never visible to
          us. If you sign in with Google, Google shares your name, email, and
          profile photo with us.
        </li>
        <li>
          <strong>Profile and listing content.</strong> Whatever you choose to
          put on your profile and listings: display name, city, bio, photos,
          social links, audience numbers, and listing details.
        </li>
        <li>
          <strong>Messages.</strong> Conversations you have with other members
          through the site.
        </li>
        <li>
          <strong>Instagram profile data, at your request.</strong> If you
          enter an Instagram handle, we look up that account&apos;s public
          profile photo and follower count to prefill your profile. We only do
          this for handles you type in yourself.
        </li>
        <li>
          <strong>Usage analytics.</strong> We use Vercel Web Analytics, which
          collects aggregate, cookie-free page view statistics. We do not run
          advertising trackers.
        </li>
      </ul>

      <h2>2. How we use it</h2>
      <p>
        To run the marketplace: showing your profile and listings to potential
        partners, delivering messages, prefilling your profile when you ask,
        keeping the service secure, and understanding which pages get visited
        so we can improve the product. We do not sell your data, and we do not
        use it for third-party advertising.
      </p>

      <h2>3. What is public and what is private</h2>
      <p>
        SideSpace is a marketplace, so profiles, listings, and the photos on
        them are public and visible to anyone who visits the site. Your email
        address and password are never public. Messages are private between
        you and the person you are talking to.
      </p>

      <h2>4. Where your data lives</h2>
      <p>
        Account data, profiles, listings, messages, and photos are stored with
        Supabase (our database and authentication provider). The site is hosted
        on Vercel. Both process data on our behalf under their own security
        practices.
      </p>

      <h2>5. Who we share data with</h2>
      <p>
        Only the service providers that make the site run: Supabase (database,
        authentication, file storage), Vercel (hosting and analytics), and
        Google (only if you choose Google sign-in). We do not sell or rent
        personal data to anyone.
      </p>

      <h2>6. Keeping and deleting data</h2>
      <p>
        We keep your data while your account exists. Deleting your account in
        Account settings permanently removes your profile, listings, messages,
        and uploaded photos, including the underlying files. You can also
        remove individual photos and listings at any time.
      </p>

      <h2>7. Children</h2>
      <p>
        SideSpace is not for children under 13, and we do not knowingly
        collect their data. If you believe a child under 13 has an account,
        contact us and we will remove it.
      </p>

      <h2>8. Changes to this policy</h2>
      <p>
        If our data practices change, for example when payments launch, we
        will update this page and its date, and flag material changes on the
        site.
      </p>

      <h2>9. Contact</h2>
      <p>
        Privacy questions or deletion requests: email{" "}
        <a href="mailto:kveldanda987@gmail.com">kveldanda987@gmail.com</a>.
        See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </main>
  );
}
