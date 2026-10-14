import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./testUtils";

const checkForUpdate = vi.fn();
vi.mock("./ipc", () => ({ checkForUpdate: () => checkForUpdate() }));

const update = await import("./update");

const info = (is_newer: boolean) => ({
  current: "1.0.1",
  latest: is_newer ? "1.1.0" : "1.0.1",
  is_newer,
  notes: "",
  url: "https://example.invalid",
});

describe("startup preference", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("defaults to off", () => {
    expect(update.checkOnStartupEnabled()).toBe(false);
  });

  it("persists on and off", () => {
    update.setCheckOnStartup(true);
    expect(update.checkOnStartupEnabled()).toBe(true);
    update.setCheckOnStartup(false);
    expect(update.checkOnStartupEnabled()).toBe(false);
  });
});

describe("runUpdateCheck", () => {
  beforeEach(() => {
    checkForUpdate.mockReset();
  });

  it("reports available when a newer release exists", async () => {
    checkForUpdate.mockResolvedValue(info(true));
    expect(await update.runUpdateCheck()).toBe("available");
    expect(update.updateStatus()).toBe("available");
    expect(update.updateInfo()?.latest).toBe("1.1.0");
  });

  it("reports current when already up to date", async () => {
    checkForUpdate.mockResolvedValue(info(false));
    expect(await update.runUpdateCheck()).toBe("current");
  });

  it("never throws: a string rejection becomes the error message", async () => {
    checkForUpdate.mockRejectedValue("offline");
    expect(await update.runUpdateCheck()).toBe("error");
    expect(update.updateError()).toBe("offline");
  });

  it("uses a generic message for non-string errors", async () => {
    checkForUpdate.mockRejectedValue(new Error("boom"));
    expect(await update.runUpdateCheck()).toBe("error");
    expect(update.updateError()).toBe("Update check failed.");
  });
});
