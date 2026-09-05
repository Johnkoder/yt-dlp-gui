/** Dependency-domain types. Mirror the Rust structs in
 * `src-tauri/src/services/dependencies.rs` (camelCase over IPC). */

export type DependencyState = "available" | "missing" | "error";

export interface DependencyInfo {
  name: string;
  state: DependencyState;
  version?: string | null;
  path?: string | null;
  message?: string | null;
}

export interface DependencyReport {
  ytDlp: DependencyInfo;
  deno: DependencyInfo;
  ffmpeg: DependencyInfo;
}
