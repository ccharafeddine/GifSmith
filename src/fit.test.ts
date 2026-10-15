import { describe, expect, it } from "vitest";
import { fitStep, MIN_WIDTH } from "./fit";

const MB = 1024 * 1024;

describe("fitStep", () => {
  it("does nothing when the file already fits", () => {
    expect(fitStep({ width: 480, fps: 15, quality: 90 }, 5 * MB, 8 * MB)).toBeNull();
  });

  it("trims quality first for a small overshoot", () => {
    expect(fitStep({ width: 540, fps: 20, quality: 88 }, 11 * MB, 10 * MB)).toEqual({ width: 540, fps: 20, quality: 73 });
  });

  it("drops fps then width for a big overshoot, never below the floors", () => {
    const n = fitStep({ width: 640, fps: 24, quality: 70 }, 40 * MB, 10 * MB)!;
    expect(n.fps).toBeLessThan(24);
    expect(n.fps).toBeGreaterThanOrEqual(12);
    expect(n.width).toBeLessThan(640);
    expect(n.width % 2).toBe(0);
    const floor = fitStep({ width: MIN_WIDTH, fps: 12, quality: 55 }, 40 * MB, 1 * MB);
    expect(floor).toBeNull();
  });

  it("converges under a simple size model", () => {
    // Model: size ∝ width² · fps · (0.5 + quality/200).
    const size = (p: { width: number; fps: number; quality: number }) => p.width * p.width * p.fps * (0.5 + p.quality / 200) * 2;
    let p = { width: 800, fps: 30, quality: 95 };
    const limit = 8 * MB;
    for (let i = 0; i < 6; i++) {
      const next = fitStep(p, size(p), limit);
      if (!next) break;
      p = next;
    }
    expect(size(p)).toBeLessThanOrEqual(limit);
  });
});
