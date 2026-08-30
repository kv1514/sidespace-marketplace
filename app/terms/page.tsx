import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern using the SideSpace marketplace.",
  // Inherited the homepage's og:url, which Slack and LinkedIn treat as a
  // canonical hint - so sharing this page unfurled as the homepage.
  alternates: { canonical: "/terms" },
  openGraph: {
    type: "article",
    siteName: "SideSpace",
    url: "/terms",
    title: "Terms of Service · SideSpace",
    description: "The terms that govern using the SideSpace marketplace.",
  },
  twitter: {
    card: "summary",
    title: "Terms of Service · SideSpace",
    description: "The terms that govern using the SideSpace marketplace.",
  },
};

export default function TermsPage() {
  return (
    <main className="legal-page">
      <Link className="legal-home" href="/">
        ← SideSpace
      </Link>
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: August 29, 2026</p>

      <h2>1. Who we are</h2>
      <p>
        SideSpace is a marketplace where people and businesses list everyday
        advertising space, from a creator&apos;s Instagram story to a storefront
        window, a vehicle, or a yard, and where advertisers find and book that
        space. These terms are an agreement between you and SideSpace
        (&quot;we&quot;, &quot;us&quot;).
      </p>

      <h2>2. Accepting these terms</h2>
      <p>
        By creating an account or using the site, you agree to these terms and
        to our <Link href="/privacy">Privacy Policy</Link>. If you do not
        agree, please do not use SideSpace.
      </p>

      <h2>3. Who can use SideSpace</h2>
      <p>
        You must be at least 13 years old. If you are under 18, you may only
        use SideSpace with the permission of a parent or guardian, and any
        agreement you make with another member should involve them.
      </p>

      <h2>4. Your account</h2>
      <p>
        Keep your login details private and tell us about any unauthorized use
        of your account. You are responsible for activity that happens under
        your account. You can delete your account at any time from Account
        settings. Payment, tax, refund, dispute, and invoice records may be
        retained or de-identified when required for accounting, fraud
        prevention, legal compliance, or resolving an open transaction.
      </p>

      <h2>5. Listings, bookings, and payments</h2>
      <p>
        Listings are created by members, and campaign scope and delivery are
        agreed between the business and the creator or host. Once both sides
        accept a campaign, the paying business may complete a one-time payment
        through Stripe Checkout. SideSpace processes the marketplace charge as
        the platform and sends the creator&apos;s share to their connected Stripe
        account. A browser redirect never confirms payment; SideSpace updates a
        campaign only after Stripe confirms it.
      </p>
      <p>
        Joining, listing, browsing, requests, and messaging have no monthly
        subscription. For a paid campaign, the business pays the agreed price
        plus a 5% buyer fee, and the creator receives the agreed price minus a
        5% creator fee. Applicable tax may be added at Checkout. Stripe
        processing costs are paid by SideSpace and do not change the displayed
        creator earnings unless a refund, dispute, negative balance, or other
        adjustment is required by these terms or Stripe&apos;s rules.
      </p>

      <h2>6. Refunds, cancellations, and disputes</h2>
      <p>
        Members should agree on deliverables, timing, and cancellation terms
        before payment. Refund requests are reviewed against those agreed terms
        and applicable law. Approved refunds are issued through Stripe and may
        reverse the related creator transfer and SideSpace fees in whole or in
        part. Card disputes are handled through Stripe; we may ask both members
        for evidence, pause payouts, or adjust a campaign&apos;s status while a
        dispute is open. Contact support promptly instead of arranging an
        off-platform reversal.
      </p>

      <h2>7. Your content</h2>
      <p>
        You own what you post: your profile, listings, photos, and messages.
        By posting, you give us permission to host and display that content so
        the marketplace can work, including showing your public profile and
        listings to visitors. Only post photos and claims you have the right
        to use, and keep audience numbers and listing details truthful.
      </p>

      <h2>8. What is not allowed</h2>
      <ul>
        <li>Misrepresenting who you are, your audience, or your space</li>
        <li>Posting content you do not have the right to post</li>
        <li>Impersonating another person or organization</li>
        <li>Harassment, spam, scams, or illegal activity of any kind</li>
        <li>Listing spaces you do not control or lack permission to offer</li>
        <li>
          Attempting to break, probe, or overload the service, or to access
          another member&apos;s account or data
        </li>
      </ul>

      <h2>9. Verification</h2>
      <p>
        A &quot;Verified by SideSpace&quot; badge means we manually reviewed
        evidence a member submitted. It is our good-faith review, not a
        guarantee, and it does not make us responsible for a member&apos;s
        conduct.
      </p>

      <h2>10. Ending or suspending accounts</h2>
      <p>
        We can suspend or remove accounts, listings, or content that break
        these terms or put other members at risk. You can stop using SideSpace
        and delete your account whenever you like.
      </p>

      <h2>11. Disclaimers</h2>
      <p>
        SideSpace is provided &quot;as is&quot; while we build it. We do not
        guarantee the service will be uninterrupted or error-free, and we do
        not vouch for any member, listing, or campaign outcome.
      </p>

      <h2>12. Limitation of liability</h2>
      <p>
        To the fullest extent allowed by law, SideSpace is not liable for
        indirect, incidental, or consequential damages, or for disputes between
        members, arising from your use of the service.
      </p>

      <h2>13. Changes to these terms</h2>
      <p>
        We may update these terms as SideSpace grows, for example when
        payment or tax rules change. We will update the date at the top of this page, and
        material changes will be flagged on the site. Using SideSpace after a
        change means you accept the updated terms.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about these terms: email{" "}
        <a href="mailto:kveldanda987@gmail.com">kveldanda987@gmail.com</a>.
      </p>
    </main>
  );
}
