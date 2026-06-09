import { beforeEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/i18n";

describe("i18n", () => {
  beforeEach(() => setLocale("en"));

  it("en by default", () => {
    expect(t("status.synced")).toBe("Notabeam: synced");
  });

  it("ru after setLocale", () => {
    setLocale("ru");
    expect(t("status.synced")).toBe("Notabeam: синхронизировано");
  });

  it("unknown language -> fallback to en", () => {
    setLocale("de");
    expect(t("status.synced")).toBe("Notabeam: synced");
  });

  it("interpolation {vars}", () => {
    const s = t("binding.mismatch", { bound: "AAA", server: "BBB" });
    expect(s).toContain("AAA");
    expect(s).toContain("BBB");
  });
});
