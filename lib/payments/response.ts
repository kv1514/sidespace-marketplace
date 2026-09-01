const participantTransactionFields = [
  "id",
  "status",
  "workflow_status",
  "payout_status",
  "delivered_at",
  "review_deadline",
  "confirmed_at",
  "issue_status",
  "payout_released_at",
] as const;

export function participantTransactionResponse(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const transaction = value as Record<string, unknown>;
  return Object.fromEntries(
    participantTransactionFields.map((field) => [field, transaction[field]]),
  );
}
