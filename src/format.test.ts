import { describe, expect, it } from "vitest";
import { formatTimecode } from "./format";

describe("formatTimecode", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(5)).toBe("0:05");
    expect(formatTimecode(65)).toBe("1:05");
    expect(formatTimecode(600)).toBe("10:00");
  });

  it("floors fractional seconds", () => {
    expect(formatTimecode(59.99)).toBe("0:59");
  });

  it("clamps NaN, infinities, and negatives to 0:00", () => {
    for (const v of [Number.NaN, -3, Number.POSITIVE_INFINITY, -Infinity]) {
      expect(formatTimecode(v)).toBe("0:00");
    }
  });
});
