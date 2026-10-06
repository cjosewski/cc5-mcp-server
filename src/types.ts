/**
 * Type definitions for CC5 MCP Server.
 */

export interface CC5Avatar {
  name: string;
  id: string;
  type: string;
}

export interface MorphEntry {
  id: string;
  display_name: string;
}

export interface MorphCatalog {
  [category: string]: MorphEntry[];
}

export interface MorphSetRequest {
  morph_id: string;
  /** Morph blend weight. Valid range: -1..1 (negative values shrink the feature, positive enlarge it). */
  value: number;
}

export interface AvatarInfo {
  name: string;
  id: string;
  active_morphs: Record<string, number>;
}

export interface CC5Response<T = unknown> {
  result?: T;
  error?: string;
}

export interface OperationResult {
  success: boolean;
  error?: string;
}

export interface CreateAvatarResult extends OperationResult {
  name?: string;
}

export interface DeleteAvatarResult extends OperationResult {
  removed?: string[];
}

export interface CaptureResult extends OperationResult {
  path?: string;
  base64?: string;
  /** Set when the plugin wrote the file but did not send it (over its 10 MB limit). */
  warning?: string;
}

export interface CameraInfo {
  name: string;
  position: { x: number; y: number; z: number };
  focal_length: number;
  error?: string;
}

export interface FocalLengthResult extends OperationResult {
  focal_length?: number;
}

export interface LightInfo {
  name: string;
  id: number;
  type: string;
}

export interface LightColorResult extends OperationResult {
  light?: string;
}

export interface LightDetailInfo {
  name: string;
  type: string;
  color: { r: number; g: number; b: number } | null;
  multiplier: number | null;
  active?: boolean | null;
  cast_shadow?: boolean | null;
  darken_shadow_strength?: number | null;
  range?: number | null;
  error?: string;
}

export interface LightMultiplierResult extends OperationResult {
  light?: string;
  multiplier?: number;
}

export interface LightActiveResult extends OperationResult {
  light?: string;
  active?: boolean;
}

export interface LightShadowResult extends OperationResult {
  light?: string;
  cast_shadow?: boolean;
  darken_shadow_strength?: number;
}

export interface VisualSettings extends OperationResult {
  ambient?: { r: number; g: number; b: number } | null;
  ibl_enabled?: boolean | null;
  /** The IBL image set_ibl loaded in this CC5 session; RLPy cannot say which image is loaded (null: none, or by hand). */
  ibl_image_loaded_by_bridge?: string | null;
}

export interface SetAmbientResult extends OperationResult {
  ambient?: { r: number; g: number; b: number };
}

export interface SetIblResult extends OperationResult {
  ibl_enabled?: boolean;
  loaded_image?: string | null;
}

export interface ExpressionInfo {
  [group: string]: string[];
}

export interface ExpressionItem {
  name: string;
  weight: number;
}

export interface ExpressionSetResult extends OperationResult {
  applied?: ExpressionItem[];
  skipped?: (string | null)[];
}

export interface ExpressionResetResult extends OperationResult {
  /** Sliders that were not at 0 before the reset (all of them when CC5 could not be read first). */
  reset_count?: number;
  /** Their names (at most 50). */
  reset?: string[];
  /** Every expression slider the character has. */
  slider_count?: number;
}

export interface ResetMorphsResult extends OperationResult {
  reset_count?: number;
}

export interface MaterialInfo {
  success?: boolean;
  meshes: Record<string, string[]>;
}

export interface DiffuseColor {
  r: number;
  g: number;
  b: number;
  error?: string;
}

export interface SetDiffuseColorResult extends OperationResult {
  mesh?: string;
  material?: string;
}

export interface MaterialProperties {
  mesh: string;
  material: string;
  opacity?: number;
  glossiness?: number;
  specular?: number;
  error?: string;
}

export interface SetMaterialPropertyResult extends OperationResult {
  mesh?: string;
  material?: string;
  opacity?: number;
  glossiness?: number;
  specular?: number;
}

export interface ShaderParameters extends OperationResult {
  mesh?: string;
  material?: string;
  shader?: string | null;
  parameters?: Record<string, number[]>;
}

export interface SetShaderParameterResult extends OperationResult {
  mesh?: string;
  material?: string;
  parameter?: string;
  values?: number[];
}

// --- Content Management (Tier 1) ---

export interface ClothingItem {
  name: string;
  id: number;
  type: string;
}

export interface HairItem {
  name: string;
  id: number;
  type: string;
}

export interface AccessoryItem {
  name: string;
  id: number;
}

export interface RemoveItemResult extends OperationResult {
  removed?: string;
}

// --- Convenience Color Shortcuts (Tier 3) ---

export interface ColorResult extends OperationResult {
  applied_to?: string[];
}

// --- Visibility & Scene (Tier 4) ---

export interface SetVisibleResult extends OperationResult {
  item?: string;
  visible?: boolean;
  /** CC5's read-back agreed (true), disagreed (false), or cannot be read for this item (null: worn items). */
  verified?: boolean | null;
  notes?: string[];
}

export interface SceneObject {
  name: string;
  id: number;
  type: string;
}

export interface SelectionResult extends OperationResult {
  /** What CC5 has selected after the call (also on a failed select, when CC5 could be read). */
  selected?: SceneObject[];
}

export interface SetSkinShaderResult extends OperationResult {
  parameter?: string;
  /** The skin materials that took the value. */
  materials?: string[];
  /** The value read back from CC5. */
  values?: number[];
  /** Materials without the parameter (or with another value count), left unchanged. */
  skipped?: string[];
}

export interface DeleteObjectResult extends OperationResult {
  /** The items CC5 removed (checked by reading the scene back). */
  deleted?: SceneObject[];
}

export interface ObjectTransformValues {
  /** Position in centimetres (x, y, z). */
  position: [number, number, number];
  scale: [number, number, number];
}

export interface ObjectTransformResult extends OperationResult, Partial<ObjectTransformValues> {
  name?: string;
  before?: ObjectTransformValues;
  after?: ObjectTransformValues;
}

export interface CC5Dialog {
  title: string;
  /** The dialog's question: a message box's text, or the visible labels of CC5's own dialogs. */
  text: string;
  /** Labels of the visible, enabled buttons. */
  buttons: string[];
  /** True for a command's own progress window (only button Cancel): not a question (F-56). */
  progress?: boolean;
}

export interface DialogResult extends OperationResult {
  /** The open dialog, or null when none is open. */
  dialog?: CC5Dialog | null;
  /** Job id of the command waiting inside the dialog, if a command opened it. */
  waiting_job?: string | null;
  /** answer_cc5_dialog: the button that was clicked. */
  clicked?: string;
  /** How this CC5 answers "Unsaved project data found" (CC5_RECOVERY_ANSWER): "cancel", "ok" or "ask". */
  recovery_policy?: string;
  /** Recovery prompts the plugin answered by itself, oldest first. */
  recovery_answered?: Array<{ time: string; button: string; text: string }>;
}

export interface LoadAssetResult extends OperationResult {
  path?: string;
  /** The character that character content (.ccEye, .ccCloth, ...) was applied to. */
  target?: string;
}

// --- Mesh-to-MetaHuman pipeline ---

export interface ExportFbxOptions {
  target_tool?: "UE5" | "Default" | "Maya" | "Unity" | "Unreal" | "Blender";
  sub_d_level?: 0 | 1 | 2;
  include_current_pose?: boolean;
  delete_hidden_faces?: boolean;
  use_smooth_mesh?: boolean;
  remove_eyelash?: boolean;
  remove_tearline_occlusion?: boolean;
  /** "Embed Textures" — bundle textures into the FBX. */
  embed_textures?: boolean;
  /** FBX Options: true = "Mesh and Motion" (default), false = "Mesh" only. */
  export_motion?: boolean;
  /** Include Motion frame rate (e.g. 30). Maps to RLPy.RFps.Fps{n}. */
  fps?: number;
  /** Include Motion frame range [start, end]. Omit for "All". */
  motion_range?: [number, number];
  /** "Convert Image Format" (TIF -> PNG). The bridge refuses it: CC5 5.13 crashes right after a scripted export with it. */
  convert_image_format?: boolean;
  /** "Max Texture Size" in pixels (0 = original). */
  texture_size?: number;
}

export interface ExportFbxResult extends OperationResult {
  path?: string;
  flags?: number;
  flags2?: number;
  flags3?: number;
  flags_applied?: boolean;
  notes?: string[];
  target_tool?: string;
  /** HD Character Subdivision Level actually applied (SetExportLevel). */
  export_level?: number;
  /** Whether motion was included ("Mesh and Motion"). */
  export_motion?: boolean;
  /** Motion frame rate actually applied. */
  fps?: number;
  /** Motion frame range actually applied. */
  motion_range?: [number, number];
  /** Max texture size actually applied. */
  texture_size?: number;
  /** Whether textures were embedded. */
  embed_textures?: boolean;
  /** Whether image format conversion was applied. */
  convert_image_format?: boolean;
}

export interface BakeSkinResult extends OperationResult {
  resolution?: number;
  triggered_action?: string;
  manual_step_required?: boolean;
  instructions?: string;
  notes?: string[];
}

export interface ExportHeadMetaHumanResult extends OperationResult {
  triggered_action?: string;
  manual_step_required?: boolean;
  instructions?: string;
  output_dir?: string;
  character_name?: string;
  gender?: string;
  notes?: string[];
}

// --- ActorMIXER PRO: Create Mixer Assets ---

/** Head-part checkboxes on the Create Mixer Assets dialog (default: all true). */
export interface MixerHeadParts {
  eyes?: boolean;
  forehead?: boolean;
  chin?: boolean;
  mouth?: boolean;
  ears?: boolean;
  nose?: boolean;
  head_shape?: boolean;
}

/** Body-part checkboxes (default: all false). */
export interface MixerBodyParts {
  body?: boolean;
  torso?: boolean;
}

/**
 * 'Save Presets' groupbox + children. `enabled` toggles the groupbox itself.
 * Default: enabled with character/head/head_parts/body on, body_parts off.
 */
export interface MixerSavePresets {
  enabled?: boolean;
  character?: boolean;
  head?: boolean;
  head_parts?: boolean;
  body?: boolean;
  body_parts?: boolean;
}

/** 'Save Avatar Presets' groupbox (default: disabled). */
export interface MixerSaveAvatarPresets {
  enabled?: boolean;
}

export interface CreateActorMixerOptions {
  morph_name?: string;
  slider_path?: string;
  use_parts_folder?: boolean;
  head_parts?: MixerHeadParts;
  body_parts?: MixerBodyParts;
  save_presets?: MixerSavePresets;
  save_avatar_presets?: MixerSaveAvatarPresets;
  /** Safety gate. false (default) => set fields then CANCEL (dry-run). true => click Create once. */
  confirm_create?: boolean;
}

export interface CreateActorMixerResult extends OperationResult {
  morph_name?: string;
  created?: boolean;
  dry_run?: boolean;
  new_presets?: string[];
  presets_dir?: string;
  scheduled?: boolean;
  notes?: string[];
  poll_endpoint?: string;
  /** True when the open avatar holds trial content; ActorMIXER refuses to run. */
  trial_content?: boolean;
}

export interface JobStatus {
  job_id: string;
  action: string;
  status: "queued" | "running" | "done" | "failed";
  result?: unknown;
  /** Set while the job waits on a CC5 dialog it opened (a confirmation or a choice), or is queued behind one. */
  dialog?: CC5Dialog;
  /** Ready-to-show text: the question, the buttons, and how to answer. */
  dialog_message?: string;
  /** A queued job: the job whose dialog it waits behind (it starts after that answer). */
  blocked_by?: string;
}

/**
 * `faces` counts polygons (RIMesh.GetFacesCount; CC characters are quads). `triangles` is what Unity and the
 * Quest budget count; `approximate` marks a mesh whose triangles were estimated as 2 per polygon. Plugins
 * older than the triangle count send no `triangles`.
 */
export interface MeshStat {
  object: string; kind: "body" | "clothing" | "hair" | "accessory"; mesh: string;
  vertices: number; faces: number; triangles?: number; approximate?: boolean; materials: number;
}
export interface MeshStatsResult {
  success: boolean; error?: string; meshes: MeshStat[];
  totals: { vertices: number; faces: number; triangles?: number; materials: number };
}
export interface MeshListResult { success: boolean; meshes?: string[]; error?: string }
