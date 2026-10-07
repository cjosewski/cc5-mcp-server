/**
 * One multi-step scene edit at a time. batch_generate_patients and apply_character_recipe delete avatars,
 * load characters and act on avatars[0]; two of them interleaved on one CC5 scene would apply recipes to
 * the wrong character and export the wrong patients. While one runs, another is refused.
 * check_fit claims the scene too (it moves the camera and captures), so a recipe or batch cannot change the
 * character mid-check, and check_fit cannot start mid-recipe.
 */

let owner: string | null = null;

/**
 * Claim the scene for `description` (e.g. "batch_generate_patients (manifest: ...)"). Returns the function
 * that releases it, or, when another run holds the scene, the message to refuse this one with. `refusing` names
 * the run being refused in that message (check_fit passes "a fit check").
 */
export function claimScene(description: string, refusing = "another batch or recipe"): (() => void) | string {
  if (owner !== null) {
    return `${owner} is still running in CC5. Wait for it to finish before starting ${refusing}: ` +
      "two at once would edit the same scene.";
  }
  owner = description;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owner = null;
  };
}
