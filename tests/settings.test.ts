import { beforeEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/i18n";
import { DEFAULT_SETTINGS, shouldShowOnboarding } from "@/settings";

beforeEach(() => setLocale("en"));

describe("shouldShowOnboarding", () => {
  it("shows onboarding while the vault is not connected", () => {
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, vaultToken: "" })).toBe(true);
  });

  it("hides onboarding once a token is set", () => {
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, vaultToken: "nb_x" })).toBe(false);
  });
});

describe("onboarding i18n", () => {
  const keys = ["onboarding.title", "onboarding.intro", "onboarding.link", "onboarding.guide"] as const;

  it("en has all onboarding keys", () => {
    for (const key of keys) expect(t(key)).not.toBe(key);
  });

  it("ru has all onboarding keys", () => {
    setLocale("ru");
    for (const key of keys) {
      const value = t(key);
      expect(value).not.toBe(key);
      expect(value).not.toBe("");
    }
  });
});
