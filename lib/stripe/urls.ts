export function requireStripeHostedUrl(
  value: string | null,
  allowedHosts: readonly string[],
) {
  if (!value) throw new Error("Stripe did not return a hosted URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new Error("Stripe returned an unexpected hosted URL.");
  }
  return url.toString();
}
