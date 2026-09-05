/**
 * Whether a toast is good news or bad.
 *
 * Toasts carry both, and the tick or the exclamation mark in front of the
 * words is often the only part a member reads. A green tick on "Add your city
 * before continuing" reads as if it worked.
 *
 * Tone is inferred from our own failure vocabulary, which is reliable only
 * for messages written in it. Plenty of real failures are not: "No microphone
 * was found on this device", "The two passwords do not match", "That current
 * password is not right" contain none of these words and were all being
 * announced with a green tick. Widening the vocabulary only moves the line -
 * the next message phrased a new way lands on the wrong side of it again - so
 * a caller that knows the tone says so, and inference is the fallback for the
 * messages whose words already carry it.
 */
export type ToastTone = "problem" | "success";

const PROBLEM_TOAST =
  /\b(could not|cannot|can't|failed|unable|must|before continuing|at least|invalid|not available|already|too (large|many|big|long|short)|expired|try again|sorry|no longer|denied|wrong|missing|did not|needs?|add your|enter a|pick a|choose a|keep it|limit|reached|not enough)\b/i;

/** An unmatched message keeps the tick rather than claiming a failure. */
export function inferToastTone(message: string): ToastTone {
  return PROBLEM_TOAST.test(message) ? "problem" : "success";
}

export function toastTone(message: string, explicit?: ToastTone): ToastTone {
  return explicit ?? inferToastTone(message);
}
