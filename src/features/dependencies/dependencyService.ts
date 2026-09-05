import { invoke } from "@tauri-apps/api/core";
import type { DependencyReport } from "./types";

/**
 * Single wrapper over the backend `check_dependencies` command.
 * The frontend never inspects PATH or the filesystem itself.
 */
export async function checkDependencies(): Promise<DependencyReport> {
  return invoke<DependencyReport>("check_dependencies");
}
