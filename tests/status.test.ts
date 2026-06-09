import { describe, expect, it } from "vitest";

import { transportToUi } from "@/ui/status";

describe("status mapping", () => {
  it("transport → ui", () => {
    expect(transportToUi("connecting")).toBe("connecting");
    expect(transportToUi("open")).toBe("synced");
    expect(transportToUi("offline")).toBe("offline");
    expect(transportToUi("unauthorized")).toBe("error");
  });
});
