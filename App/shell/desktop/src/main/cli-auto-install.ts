/**
 * Where a packaged app may install its CLI.
 *
 * A disk image and App Translocation both vanish after the first look, so a symlink made there
 * would point nowhere once the person ejects the image or launches the real copy.
 */
export type BundledCliInstallDecision = "install" | "disk-image" | "translocated";

export function bundledCliInstallDecision(bundlePath: string): BundledCliInstallDecision {
  const normalized = bundlePath.replaceAll("\\", "/");
  if (normalized === "/Volumes" || normalized.startsWith("/Volumes/")) return "disk-image";
  if (normalized.includes("/AppTranslocation/")) return "translocated";
  return "install";
}

/**
 * Shell files that must mention ~/.local/bin. `.zshenv` is read by non-interactive zsh, which is
 * how an agent runs a command; `.zshrc` alone is only an interactive terminal.
 */
export const USER_CLI_SHELL_PROFILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile"] as const;

/** On the default macOS PATH, so a Dock-launched agent can run the command without a shell profile. */
export const SYSTEM_CLI_BIN_DIRECTORY = "/usr/local/bin";
