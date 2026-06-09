import { beforeEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/i18n";

describe("i18n", () => {
  beforeEach(() => setLocale("en"));

  it("en по умолчанию", () => {
    expect(t("status.synced")).toBe("Notabeam: synced");
  });

  it("ru после setLocale", () => {
    setLocale("ru");
    expect(t("status.synced")).toBe("Notabeam: синхронизировано");
  });

  it("неизвестный язык → фолбэк на en", () => {
    setLocale("de");
    expect(t("status.synced")).toBe("Notabeam: synced");
  });

  it("интерполяция {vars}", () => {
    const s = t("binding.mismatch", { bound: "AAA", server: "BBB" });
    expect(s).toContain("AAA");
    expect(s).toContain("BBB");
  });
});
