/**
 * The protocol rules Chad set for building characters, shared by the tool descriptions and the MCP server
 * instructions: I-02 (the Reallusion store when nothing installed fits), I-03 (a pick list before loading),
 * F-34 (every content load compared before and after), F-44 (check the fit), I-06 (build in stages) and
 * D1/D3 (a CC5 question stops the run; "Replace / Material Only" has no standing answer).
 *
 * LAYER_RULE and LAYER_STOP_ADVICE follow Chad's answer to what counts as one build (DEC-1, 2026-10-06): one
 * character when building interactively, one batch run in a batch.
 */

export const PICK_RULE =
  "Pick list first: when the user's ask leaves the choice open ('dress him', 'give him a hat', 'make him look older'), " +
  "show the items you plan to apply (name, file path, what it changes) and wait for the user's go-ahead before loading " +
  "anything; items the user named or already approved need no list.";

export const STORE_RULE =
  "If nothing installed fits, search the Reallusion store (Content Store and Marketplace) on the web and suggest " +
  "options: name, link, price, and whether it works in CC5 (CC4/CC5 compatible, the right content type). Only " +
  "suggest: the user decides, buys or downloads it and says where it was installed; then load it from there.";

export const STORE_HINT =
  "If nothing installed fits, you can search the Reallusion store (Content Store, Marketplace) on the web and " +
  "suggest options with name, link, price and CC5 fit; the user decides and buys.";

export const PRESET_RULE =
  "Presets and clothing can change more than they are named for (live: a lip makeup preset hid hair and brows and " +
  "reset the skin colour; uniform pants removed the template's Boxers). Every character-content load is compared " +
  "before and after: show the CHECK and NOT CHECKED lines to the user, with captures, and offer undo before " +
  "changing the character again.";

export const FIT_RULE =
  "After clothing, shoes, hats or hair, run check_fit and show the user every view: a single capture missed a " +
  "scalp poking through a hat.";

/**
 * Depends on Chad's Q1 (what counts as one build); written for the recommended option. A Cancel is never carried
 * (RB-6, DEC-7): it rejects one item, so the next identical question goes to the user again.
 */
export const LAYER_RULE =
  "Replace / Material Only has no standing answer: the user answers the first one in a build (one character, or " +
  "one batch run); answer later ones in that build with that choice (not a Cancel) and say so, never in another build.";

export const BUILD_RULE =
  "Build stage by stage: body and face first, then skin, makeup and eye presets and hair, then clothing, shoes and " +
  "accessories; a fully dressed template is only an alternative. When a load, recipe or batch stops on a CC5 " +
  "question, run nothing else until it is answered: answer a plain confirmation of exactly what the user asked for " +
  "yourself and say so; for a real choice show the question and buttons with your recommendation and let the user " +
  "pick; then go on with the call the report gives. " + LAYER_RULE;

export const BATCH_RULE =
  "Before starting a batch, show the user every variant (name, assets, settings) and wait for the go-ahead unless " +
  "the user wrote the recipes; nothing is checked visually during the run, so first build one variant with " +
  "apply_character_recipe and check it.";

export const NOT_A_CHECK =
  "A step reported OK means CC5 ran it, not that the result looks right: check with captures.";

/**
 * RB-6: layer_answer takes only Replace and Material Only (a Cancel rejects one item and is never carried), so after
 * a Cancel the run goes on without it.
 */
export const CANCEL_NOT_CARRIED =
  "If the user picked Cancel, go on with continue_after and no layer_answer: a Cancel is not carried, and the next " +
  "identical question goes to the user again.";

/** Depends on Chad's Q1 (what counts as one build); written for the recommended option. */
export const LAYER_STOP_ADVICE =
  "This is a real choice. Unless the user already chose Replace or Material Only for this character earlier in this " +
  "build (then use that choice and say so), show the user the question and buttons with your recommendation and let " +
  "them pick. Answer it with answer_cc5_dialog and expect 'target object layer already exists', then go on with " +
  `layer_answer set to that button. ${CANCEL_NOT_CARRIED}`;

/**
 * Sent as the MCP server instructions. Claude Code cuts server instructions at about 2,000 characters, so this stays
 * below that (a test checks it). If an edit goes over, shorten PRESET_RULE's live example; never drop a rule.
 */
export const SERVER_INSTRUCTIONS =
  "Rules for every Character Creator 5 (CC5) session:" +
  [PICK_RULE, STORE_RULE, PRESET_RULE, FIT_RULE, BUILD_RULE, NOT_A_CHECK].map((rule) => `\n- ${rule}`).join("");
