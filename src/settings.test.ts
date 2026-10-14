import { beforeEach, describe, expect, it } from "vitest";
import { installMemoryStorage } from "./testUtils";
import { setStoredExportsDir, storedExportsDir } from "./settings";

describe("exports dir setting", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("is null until the user picks a folder", () => {
    expect(storedExportsDir()).toBeNull();
  });

  it("round-trips a Windows path unchanged", () => {
    const dir = "C:\\Users\\me\\Videos\\GIFs";
    setStoredExportsDir(dir);
    expect(storedExportsDir()).toBe(dir);
  });

  it("keeps only the latest choice", () => {
    setStoredExportsDir("/a");
    setStoredExportsDir("/b");
    expect(storedExportsDir()).toBe("/b");
  });
});
