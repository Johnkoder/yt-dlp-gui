// Lightweight dev-environment check. Prints versions and validates the
// basics (Node floor from package.json engines, bundled yt-dlp binary).
// No installation, no downloads, no side effects.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function check(label, ok, detail = "") {
  const mark = ok ? "ok  " : "FAIL";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failed = true;
  }
}

function note(label, ok, detail = "") {
  // Informational only: never fails the script.
  const mark = ok ? "ok  " : "info";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

// 1. Node version against package.json engines.
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
);
const engines = pkg.engines?.node ?? "";
const minMatch = />=\s*(\d+\.\d+\.\d+)/.exec(engines);
const current = parseVersion(process.version);
const minimum = minMatch ? parseVersion(minMatch[1]) : null;
if (current && minimum) {
  const meets =
    current[0] > minimum[0] ||
    (current[0] === minimum[0] &&
      (current[1] > minimum[1] ||
        (current[1] === minimum[1] && current[2] >= minimum[2])));
  check(
    `node ${process.version} (needs ${engines})`,
    meets,
    meets ? "" : "upgrade Node.js",
  );
} else {
  check(`node ${process.version}`, true, "no engines floor found");
}

// 2. Bundled yt-dlp binary launches.
const binary = join(
  repoRoot,
  "src-tauri",
  "resources",
  "bin",
  "yt-dlp.exe",
);
if (!existsSync(binary)) {
  check("yt-dlp.exe", false, `missing at ${binary}`);
} else {
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
    check("yt-dlp.exe", true, `version ${version}`);
  } catch (error) {
    check("yt-dlp.exe", false, `exists but failed to run: ${error.message}`);
  }
}

// 3. Rust toolchain, informational only (needed for Tauri builds).
for (const tool of ["rustc", "cargo"]) {
  try {
    const version = execFileSync(
      process.platform === "win32" ? `${tool}.exe` : tool,
      ["--version"],
      { encoding: "utf-8", timeout: 30000 },
    ).trim();
    note(tool, true, version);
  } catch {
    note(tool, false, "not on PATH (needed for Tauri builds)");
  }
}

process.exit(failed ? 1 : 0);
