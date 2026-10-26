import { describe, expect, it } from "vitest";
import { bundledCliInstallDecision } from "../src/main/cli-auto-install.js";

describe("bundled CLI install decision", () => {
  it("installs from Applications, the home Applications folder, and Downloads", () => {
    expect(bundledCliInstallDecision("/Applications/Memmy.app")).toBe("install");
    expect(bundledCliInstallDecision("/Users/ada/Applications/Memmy.app")).toBe("install");
    expect(bundledCliInstallDecision("/Users/ada/Downloads/Memmy.app")).toBe("install");
  });

  it("does not install from a disk image or an App Translocation path", () => {
    expect(bundledCliInstallDecision("/Volumes/Memmy Installer/Memmy.app")).toBe("disk-image");
    expect(bundledCliInstallDecision("/private/var/folders/xx/T/AppTranslocation/ABC/d/Memmy.app")).toBe("translocated");
  });
});
