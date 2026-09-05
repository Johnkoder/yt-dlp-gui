//! Dependency detection: yt-dlp, Deno, FFmpeg.
//!
//! The backend owns all environment inspection — the frontend never touches
//! PATH, the filesystem, or version commands. Detection is read-only:
//! nothing is installed, modified, or executed beyond `<binary> --version`
//! style probes with a timeout.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;

use super::ytdlp::resolve_ytdlp_path;

/// How long one version probe may take before it counts as failed.
const VERSION_TIMEOUT: Duration = Duration::from_secs(4);

/// Availability of a single dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DependencyState {
    Available,
    Missing,
    Error,
}

/// Structured status for one dependency. Raw console output is never the
/// primary API; only concise, display-ready fields are exposed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub name: String,
    pub state: DependencyState,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// One report covering every dependency. Always returned whole, even when
/// individual probes fail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub yt_dlp: DependencyInfo,
    pub deno: DependencyInfo,
    pub ffmpeg: DependencyInfo,
}

// --- Generic helpers --------------------------------------------------------

/// Search explicit directories for a backend-defined executable filename.
/// Pure over its inputs (no process-wide PATH reads), so tests can pass
/// temp dirs directly. No recursion, no registry, no shell.
pub fn find_executable_in_dirs(file_name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(file_name))
        .find(|p| p.is_file())
}

/// Search the process PATH for a backend-defined executable filename.
/// Only `file_name` (a constant like `deno.exe`) varies the lookup; user
/// input plays no role in executable selection.
pub fn find_executable_on_path(file_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    find_executable_in_dirs(file_name, &dirs)
}

/// Run `<binary> <args>` and capture trimmed stdout. Times out instead of
/// hanging on a broken executable; never panics.
async fn run_version_command(
    binary: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let child = TokioCommand::new(binary)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("Could not launch {}: {}", binary.display(), err))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "Timed out while checking version.".to_string())?
        .map_err(|err| format!("Could not read version output: {}", err))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "Version command failed.".to_string()
        } else {
            super::ytdlp::first_meaningful_line(detail)
                .unwrap_or_else(|| "Version command failed.".to_string())
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// --- Version parsing (defensive, display-oriented) --------------------------

/// `2026.08.19\n` → `2026.08.19`.
pub fn parse_ytdlp_version(output: &str) -> Option<String> {
    let version = output.lines().next()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// `deno 2.9.6 (stable, …)\nv8 …\ntypescript …` → `2.9.6`.
pub fn parse_deno_version(output: &str) -> Option<String> {
    let first = output.lines().next()?.trim();
    let mut parts = first.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("deno"), Some(version)) => Some(version.to_string()),
        _ => None,
    }
}

/// `ffmpeg version 8.0-full_build Copyright …` → `8.0-full_build`.
/// Falls back to the whole first line when the shape is unexpected.
pub fn parse_ffmpeg_version(output: &str) -> Option<String> {
    let first = output.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    if let Some(rest) = first.strip_prefix("ffmpeg version ") {
        let version = rest.split_whitespace().next().unwrap_or("").trim();
        if !version.is_empty() {
            return Some(version.to_string());
        }
    }
    Some(first.to_string())
}

fn missing(name: &str, message: &str) -> DependencyInfo {
    DependencyInfo {
        name: name.to_string(),
        state: DependencyState::Missing,
        version: None,
        path: None,
        message: Some(message.to_string()),
    }
}

fn failed(name: &str, path: &Path, message: String) -> DependencyInfo {
    DependencyInfo {
        name: name.to_string(),
        state: DependencyState::Error,
        version: None,
        path: Some(path.to_string_lossy().to_string()),
        message: Some(message),
    }
}

// --- Per-dependency checks --------------------------------------------------

async fn check_ytdlp(app: &AppHandle) -> DependencyInfo {
    const NAME: &str = "yt-dlp";
    let binary = match resolve_ytdlp_path(app) {
        Ok(path) => path,
        Err(_) => {
            return missing(NAME, "yt-dlp is required to download media.");
        }
    };
    match run_version_command(&binary, &["--version"], VERSION_TIMEOUT).await {
        Ok(output) => match parse_ytdlp_version(&output) {
            Some(version) => DependencyInfo {
                name: NAME.to_string(),
                state: DependencyState::Available,
                version: Some(version),
                path: Some(binary.to_string_lossy().to_string()),
                message: None,
            },
            None => failed(
                NAME,
                &binary,
                "yt-dlp returned an unreadable version.".to_string(),
            ),
        },
        Err(message) => failed(NAME, &binary, message),
    }
}

/// How a Deno installation was found. Shared by the dependency checker and
/// the yt-dlp launcher so "Available" always means "usable by downloads".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenoSource {
    /// Found via normal PATH lookup: children inherit it unchanged.
    OnPath,
    /// Found only at the per-user fallback: the yt-dlp child process needs
    /// the containing directory prepended to its own PATH.
    UserFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDeno {
    pub path: PathBuf,
    pub source: DenoSource,
}

const DENO_FILE_NAME: &str = "deno.exe";

/// Resolve Deno against explicit directory lists. Pure over its inputs so
/// tests pass temp dirs directly: PATH dirs win, the fallback dir is only
/// consulted when PATH has no Deno.
pub fn resolve_deno_in(path_dirs: &[PathBuf], fallback_dir: Option<&Path>) -> Option<ResolvedDeno> {
    if let Some(path) = find_executable_in_dirs(DENO_FILE_NAME, path_dirs) {
        return Some(ResolvedDeno {
            path,
            source: DenoSource::OnPath,
        });
    }
    let dir = fallback_dir?;
    let path = dir.join(DENO_FILE_NAME);
    if path.is_file() {
        Some(ResolvedDeno {
            path,
            source: DenoSource::UserFallback,
        })
    } else {
        None
    }
}

/// Resolve Deno in the real environment: normal PATH first, then the
/// standard per-user install location.
pub fn resolve_deno() -> Option<ResolvedDeno> {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let fallback = dirs::home_dir().map(|home| home.join(".deno").join("bin"));
    resolve_deno_in(&path_dirs, fallback.as_deref())
}

/// Build a child-process PATH with `dir` prepended, preserving every
/// existing entry. Uses the platform split/join helpers (no manual `;`
/// concatenation), skips prepending when already present, and tolerates
/// spaces and Unicode. The result is meant for one
/// `Command::env("PATH", …)` call — the system environment is never
/// modified.
pub fn prepend_to_path_list(
    existing: Option<std::ffi::OsString>,
    dir: &Path,
) -> Result<std::ffi::OsString, String> {
    let mut dirs: Vec<PathBuf> = existing
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if !dirs.iter().any(|candidate| candidate == dir) {
        dirs.insert(0, dir.to_path_buf());
    }
    std::env::join_paths(dirs).map_err(|err| format!("Could not build PATH value: {}", err))
}

/// Directory the yt-dlp child process needs on its own PATH so it can
/// discover Deno, if any: `Some` only when Deno exists solely at the user
/// fallback (PATH installations need no adjustment).
pub fn deno_child_path_dir() -> Option<PathBuf> {
    match resolve_deno() {
        Some(deno) if deno.source == DenoSource::UserFallback => {
            deno.path.parent().map(Path::to_path_buf)
        }
        _ => None,
    }
}

async fn check_deno() -> DependencyInfo {
    const NAME: &str = "Deno";
    let deno = match resolve_deno() {
        Some(resolved) => resolved,
        None => {
            return missing(
                NAME,
                "Deno was not found. Some sites, including YouTube, may not work fully without a JavaScript runtime.",
            );
        }
    };
    let binary = deno.path;
    match run_version_command(&binary, &["--version"], VERSION_TIMEOUT).await {
        Ok(output) => match parse_deno_version(&output) {
            Some(version) => DependencyInfo {
                name: NAME.to_string(),
                state: DependencyState::Available,
                version: Some(version),
                path: Some(binary.to_string_lossy().to_string()),
                message: None,
            },
            None => failed(
                NAME,
                &binary,
                "Deno returned an unreadable version.".to_string(),
            ),
        },
        Err(message) => failed(NAME, &binary, message),
    }
}

async fn check_ffmpeg() -> DependencyInfo {
    const NAME: &str = "FFmpeg";
    const FILE: &str = "ffmpeg.exe";
    let binary = match find_executable_on_path(FILE) {
        Some(path) => path,
        None => {
            return missing(
                NAME,
                "FFmpeg was not found. High-quality video streams may not be mergeable, and audio conversion will be unavailable.",
            );
        }
    };
    let ffprobe = find_executable_on_path("ffprobe.exe").is_some();
    let toolset = if ffprobe {
        "ffprobe available"
    } else {
        "ffprobe not found"
    };
    match run_version_command(&binary, &["-version"], VERSION_TIMEOUT).await {
        Ok(output) => match parse_ffmpeg_version(&output) {
            Some(version) => DependencyInfo {
                name: NAME.to_string(),
                state: DependencyState::Available,
                version: Some(version),
                path: Some(binary.to_string_lossy().to_string()),
                message: Some(toolset.to_string()),
            },
            None => failed(
                NAME,
                &binary,
                "FFmpeg returned an unreadable version.".to_string(),
            ),
        },
        Err(message) => failed(NAME, &binary, message),
    }
}

/// Detect every dependency and return one whole report. Individual probes
/// fail independently — a missing Deno never hides FFmpeg's status.
pub async fn check_all(app: &AppHandle) -> DependencyReport {
    DependencyReport {
        yt_dlp: check_ytdlp(app).await,
        deno: check_deno().await,
        ffmpeg: check_ffmpeg().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    #[test]
    fn parses_ytdlp_version() {
        assert_eq!(
            parse_ytdlp_version("2026.08.19\n"),
            Some("2026.08.19".to_string())
        );
        assert_eq!(
            parse_ytdlp_version("  2025.01.01  \r\n"),
            Some("2025.01.01".to_string())
        );
        assert_eq!(parse_ytdlp_version(""), None);
        assert_eq!(parse_ytdlp_version("   \n"), None);
    }

    #[test]
    fn parses_deno_version() {
        let output = "deno 2.9.6 (stable, release, x86_64-pc-windows-msvc)\n\
             v8 15.0.245.2-rusty\n\
             typescript 6.0.3\n";
        assert_eq!(parse_deno_version(output), Some("2.9.6".to_string()));
        assert_eq!(
            parse_deno_version("deno 1.46.3\n"),
            Some("1.46.3".to_string())
        );
        assert_eq!(parse_deno_version("v8 15.0\n"), None);
        assert_eq!(parse_deno_version(""), None);
    }

    #[test]
    fn parses_ffmpeg_version() {
        assert_eq!(
            parse_ffmpeg_version(
                "ffmpeg version N-119381-gfcc562693e-20250428 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 14.2.0"
            ),
            Some("N-119381-gfcc562693e-20250428".to_string())
        );
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 8.0-full_build Copyright (c)"),
            Some("8.0-full_build".to_string())
        );
        assert_eq!(parse_ffmpeg_version(""), None);
        // Unexpected shape: fall back to the raw first line.
        assert_eq!(
            parse_ffmpeg_version("weird output\nsecond"),
            Some("weird output".to_string())
        );
    }

    #[test]
    fn resolves_executables_from_directories() {
        let dir = test_dir("ytdlp_gui_dep_test");
        let exe = dir.join("deno.exe");
        std::fs::write(&exe, b"fake").expect("test file");

        assert_eq!(
            find_executable_in_dirs("deno.exe", std::slice::from_ref(&dir)),
            Some(exe.clone())
        );
        assert_eq!(
            find_executable_in_dirs("ffmpeg.exe", std::slice::from_ref(&dir)),
            None,
            "missing executable must be None"
        );
        assert_eq!(
            find_executable_in_dirs("deno.exe", &[]),
            None,
            "empty search list must be None"
        );
        assert_eq!(
            find_executable_in_dirs("deno.exe", &[dir.join("no-such-subdir"), dir.clone()]),
            Some(exe.clone()),
            "skips missing dirs, finds later ones"
        );
        std::fs::remove_file(&exe).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn resolves_paths_with_spaces_and_unicode() {
        let dir = test_dir("ytdlp_gui_dep test 日本語 🎬");
        let exe = dir.join("ffmpeg.exe");
        std::fs::write(&exe, b"fake").expect("test file");
        assert_eq!(
            find_executable_in_dirs("ffmpeg.exe", std::slice::from_ref(&dir)),
            Some(exe.clone()),
            "spaces/unicode must not break resolution"
        );
        std::fs::remove_file(&exe).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn report_serializes_camel_case() {
        let report = DependencyReport {
            yt_dlp: DependencyInfo {
                name: "yt-dlp".to_string(),
                state: DependencyState::Available,
                version: Some("2026.08.19".to_string()),
                path: Some("C:\\bin\\yt-dlp.exe".to_string()),
                message: None,
            },
            deno: DependencyInfo {
                name: "Deno".to_string(),
                state: DependencyState::Missing,
                version: None,
                path: None,
                message: Some("not found".to_string()),
            },
            ffmpeg: DependencyInfo {
                name: "FFmpeg".to_string(),
                state: DependencyState::Error,
                version: None,
                path: None,
                message: Some("Timed out while checking version.".to_string()),
            },
        };
        let json = serde_json::to_value(&report).expect("serializes");
        assert_eq!(json["ytDlp"]["state"], "available");
        assert_eq!(json["ytDlp"]["version"], "2026.08.19");
        assert_eq!(json["deno"]["state"], "missing");
        assert_eq!(json["ffmpeg"]["state"], "error");
    }

    #[tokio::test]
    async fn version_command_reports_real_binary() {
        // The repo's own binary: exercises spawn + capture + timeout plumbing
        // without depending on system software or the network. Pins the
        // version SHAPE (date-style releases), never the exact release.
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin")
            .join("yt-dlp.exe");
        if !binary.is_file() {
            return;
        }
        let output = run_version_command(&binary, &["--version"], Duration::from_secs(30))
            .await
            .expect("bundled yt-dlp must answer --version");
        let version = parse_ytdlp_version(&output).expect("version should parse");
        assert!(!version.trim().is_empty());
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(parts.len(), 3, "unexpected version shape: {}", version);
        assert!(
            parts
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())),
            "unexpected version shape: {}",
            version
        );
        assert_eq!(parts[0].len(), 4, "year part expected: {}", version);
    }

    #[tokio::test]
    async fn version_command_timeout_becomes_error() {
        // The frozen binary needs ~hundreds of ms to start, so a 1ms budget
        // deterministically exercises the timeout path.
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("bin")
            .join("yt-dlp.exe");
        if !binary.is_file() {
            return;
        }
        let err = run_version_command(&binary, &["--version"], Duration::from_millis(1))
            .await
            .expect_err("tiny budget must time out");
        assert_eq!(err, "Timed out while checking version.");
    }

    #[tokio::test]
    async fn version_command_missing_binary_is_error() {
        let err = run_version_command(
            Path::new("C:\\ytdlp_gui_no_such_dir_xyz\\nope.exe"),
            &["--version"],
            Duration::from_secs(5),
        )
        .await
        .expect_err("missing binary must error, not panic");
        assert!(
            err.contains("Could not launch"),
            "unexpected message: {}",
            err
        );
    }

    fn fake_deno(dir: &Path) -> PathBuf {
        let exe = dir.join("deno.exe");
        std::fs::write(&exe, b"fake").expect("test file");
        exe
    }

    #[test]
    fn deno_resolution_prefers_path() {
        // A: Deno in the first PATH dir wins, fallback untouched.
        let path_dir = test_dir("ytdlp_gui_deno_a");
        let fallback = test_dir("ytdlp_gui_deno_a_fb");
        let exe = fake_deno(&path_dir);
        let resolved = resolve_deno_in(std::slice::from_ref(&path_dir), Some(&fallback))
            .expect("must resolve");
        assert_eq!(resolved.path, exe);
        assert_eq!(resolved.source, DenoSource::OnPath);
        std::fs::remove_file(&exe).ok();
        std::fs::remove_dir(&path_dir).ok();
        std::fs::remove_dir(&fallback).ok();
    }

    #[test]
    fn deno_resolution_uses_fallback() {
        // B: missing from PATH dirs, present in fallback.
        let path_dir = test_dir("ytdlp_gui_deno_b");
        let fallback = test_dir("ytdlp_gui_deno_b_fb");
        let exe = fake_deno(&fallback);
        let resolved = resolve_deno_in(std::slice::from_ref(&path_dir), Some(&fallback))
            .expect("must resolve");
        assert_eq!(resolved.path, exe);
        assert_eq!(resolved.source, DenoSource::UserFallback);
        std::fs::remove_file(&exe).ok();
        std::fs::remove_dir(&path_dir).ok();
        std::fs::remove_dir(&fallback).ok();
    }

    #[test]
    fn deno_resolution_path_beats_fallback() {
        // C: present in both — PATH wins so no child adjustment is needed.
        let path_dir = test_dir("ytdlp_gui_deno_c");
        let fallback = test_dir("ytdlp_gui_deno_c_fb");
        let path_exe = fake_deno(&path_dir);
        let _fallback_exe = fake_deno(&fallback);
        let resolved = resolve_deno_in(std::slice::from_ref(&path_dir), Some(&fallback))
            .expect("must resolve");
        assert_eq!(resolved.path, path_exe);
        assert_eq!(resolved.source, DenoSource::OnPath);
        std::fs::remove_file(&path_exe).ok();
        std::fs::remove_file(fallback.join("deno.exe")).ok();
        std::fs::remove_dir(&path_dir).ok();
        std::fs::remove_dir(&fallback).ok();
    }

    #[test]
    fn deno_resolution_none_when_absent() {
        // D: nowhere — and no fallback configured.
        let path_dir = test_dir("ytdlp_gui_deno_d");
        assert_eq!(resolve_deno_in(std::slice::from_ref(&path_dir), None), None);
        let fallback = test_dir("ytdlp_gui_deno_d_fb");
        assert_eq!(
            resolve_deno_in(std::slice::from_ref(&path_dir), Some(&fallback)),
            None
        );
        std::fs::remove_dir(&path_dir).ok();
        std::fs::remove_dir(&fallback).ok();
    }

    #[test]
    fn deno_resolution_tolerates_spaces_and_unicode() {
        // E: spaces/Unicode in the fallback path work.
        let path_dir = test_dir("ytdlp_gui_deno_e");
        let fallback = test_dir("ytdlp_gui_deno e 日本語 🎬");
        let exe = fake_deno(&fallback);
        let resolved = resolve_deno_in(std::slice::from_ref(&path_dir), Some(&fallback))
            .expect("must resolve");
        assert_eq!(resolved.path, exe);
        assert_eq!(resolved.source, DenoSource::UserFallback);
        std::fs::remove_file(&exe).ok();
        std::fs::remove_dir(&path_dir).ok();
        std::fs::remove_dir(&fallback).ok();
    }

    fn path_list(dirs: &[&str]) -> Option<std::ffi::OsString> {
        let paths: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
        Some(std::env::join_paths(paths).expect("test paths join"))
    }

    fn split_list(value: &std::ffi::OsString) -> Vec<PathBuf> {
        std::env::split_paths(value).collect()
    }

    #[test]
    fn child_path_prepends_fallback_dir() {
        // Existing A;B + fallback D → D;A;B.
        let existing = path_list(&["C:\\A", "C:\\B"]);
        let result = prepend_to_path_list(existing, Path::new("C:\\D")).expect("must build");
        assert_eq!(
            split_list(&result),
            vec![
                PathBuf::from("C:\\D"),
                PathBuf::from("C:\\A"),
                PathBuf::from("C:\\B"),
            ]
        );
    }

    #[test]
    fn child_path_skips_duplicate_dir() {
        // D already present → unchanged, not duplicated.
        let existing = path_list(&["C:\\D", "C:\\A"]);
        let result =
            prepend_to_path_list(existing.clone(), Path::new("C:\\D")).expect("must build");
        assert_eq!(split_list(&result), split_list(&existing.unwrap()));
    }

    #[test]
    fn child_path_handles_missing_path_and_tricky_names() {
        // No existing PATH → just the directory.
        let dir = PathBuf::from("C:\\My Tools (x86) 日本語 🎬");
        let result = prepend_to_path_list(None, &dir).expect("must build");
        assert_eq!(split_list(&result), vec![dir]);
    }
}
