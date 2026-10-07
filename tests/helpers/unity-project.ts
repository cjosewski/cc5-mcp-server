/**
 * Stand-in Unity projects for the export_for_unity tests: export_for_unity refuses an Assets folder unless a Unity
 * project's ProjectSettings\ProjectVersion.txt sits beside it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Writes <root>/ProjectSettings/ProjectVersion.txt (the file that marks a Unity project) and returns its path. */
export function markUnityProject(root: string): string {
  const marker = path.join(root, "ProjectSettings", "ProjectVersion.txt");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "m_EditorVersion: 6000.2.10f1\n");
  return marker;
}

/** A new temp folder that is already marked as a Unity project: export_for_unity accepts <it>/Assets/... */
export function makeUnityProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-unity-"));
  markUnityProject(root);
  return root;
}
