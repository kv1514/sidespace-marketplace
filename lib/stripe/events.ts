export type StoredWebhookEvent = {
  status: "processing" | "processed" | "failed";
  receivedAt: number;
};

export function webhookClaimAction(
  event: StoredWebhookEvent,
  now: number,
  staleAfterMs = 5 * 60_000,
) {
  if (event.status === "processed") return "duplicate" as const;
  if (
    event.status === "processing" &&
    now - event.receivedAt <= staleAfterMs
  ) {
    return "busy" as const;
  }
  return "reclaim" as const;
}
