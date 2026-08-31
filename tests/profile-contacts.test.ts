import { describe, expect, it } from "vitest";

import {
  splitProfileWrite,
  withProfileContacts,
} from "../lib/profile-contacts";

// `public.profiles` carries a table-level SELECT grant for anon - the homepage
// embed cannot resolve without one - so a private value left in a profiles
// write is republished to every anonymous caller. These two functions are the
// only thing keeping that from happening, so pin their behaviour.
describe("private profile fields never reach the world-readable row", () => {
  it("peels every private key out of a profile write", () => {
    const { profile, contacts } = splitProfileWrite({
      auth_user_id: "user-1",
      display_name: "Room 114",
      city: "Berkeley",
      contact_email: "someone@example.com",
      contact_name: "A Person",
      business_preferences: { categories: ["Art"] },
    });

    expect(profile).toEqual({
      auth_user_id: "user-1",
      display_name: "Room 114",
      city: "Berkeley",
    });
    expect(contacts).toEqual({
      contact_email: "someone@example.com",
      contact_name: "A Person",
      business_preferences: { categories: ["Art"] },
    });
    // The important assertion: nothing private survives into the public row.
    for (const key of ["contact_email", "contact_name", "business_preferences"]) {
      expect(profile).not.toHaveProperty(key);
    }
  });

  it("leaves a write with no private fields untouched", () => {
    const { profile, contacts } = splitProfileWrite({
      display_name: "Jay",
      followers: 2900,
    });
    expect(profile).toEqual({ display_name: "Jay", followers: 2900 });
    expect(contacts).toEqual({});
  });

  it("folds the private fields back on for the app to read", () => {
    const merged = withProfileContacts(
      { id: "p1", display_name: "Room 114" },
      { contact_email: "someone@example.com", contact_name: "A Person" },
    );
    expect(merged.contact_email).toBe("someone@example.com");
    expect(merged.contact_name).toBe("A Person");
    expect(merged.display_name).toBe("Room 114");
  });

  // A member with no row yet must read as empty strings, not undefined: the
  // onboarding form binds these to controlled inputs, and undefined would make
  // React switch them to uncontrolled mid-edit.
  it("reads as empty, not undefined, when no private row exists", () => {
    const merged = withProfileContacts({ id: "p1" }, null);
    expect(merged.contact_email).toBe("");
    expect(merged.contact_name).toBe("");
    expect(merged.business_preferences).toBeNull();
  });
});
