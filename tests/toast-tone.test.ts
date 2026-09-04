import { describe, expect, it } from "vitest";

import { inferToastTone, toastTone } from "../lib/toast-tone";

describe("toast tone", () => {
  it("reads our failure vocabulary as a problem", () => {
    for (const message of [
      "We could not load your listings. Please try again.",
      "You cannot like your own listing.",
      "That listing is no longer available.",
      "That recording is too long. Keep it under a minute.",
      "Use at least 8 characters for your new password.",
      "You have reached the limit of 25 listings.",
      "Something went wrong. Please try again.",
    ]) {
      expect(inferToastTone(message)).toBe("problem");
    }
  });

  it("leaves a plain confirmation alone", () => {
    for (const message of [
      "Cover photo updated.",
      "Walkthrough removed.",
      "Listing link copied.",
      "Counteroffer sent to the requester.",
      "Your password has been updated.",
      "Portfolio item published to your Creator profile.",
    ]) {
      expect(inferToastTone(message)).toBe("success");
    }
  });

  /**
   * The reason callers can state a tone at all. Every message below is a
   * refusal, and none of them is written in the vocabulary above - so each
   * one was being announced with a green tick, as if it had worked.
   */
  it("lets a caller name the tone the words do not carry", () => {
    for (const message of [
      "No microphone was found on this device. Type a few words instead.",
      "The two passwords do not match.",
      "That current password is not right.",
      "Voice input isn't available in this browser. Type a few words instead.",
      "Sign in to like listings.",
      "This is your listing. Manage incoming requests in Dashboard.",
      "Finish your Business or Creator profile before publishing a listing.",
    ]) {
      expect(inferToastTone(message)).toBe("success");
      expect(toastTone(message, "problem")).toBe("problem");
    }
  });

  it("falls back to the words when no tone is given", () => {
    expect(toastTone("Cover photo updated.")).toBe("success");
    expect(toastTone("We could not reach the server.")).toBe("problem");
    expect(toastTone("Cover photo updated.", "problem")).toBe("problem");
    expect(toastTone("We could not reach the server.", "success")).toBe(
      "success",
    );
  });
});
