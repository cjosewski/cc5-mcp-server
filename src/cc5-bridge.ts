/**
 * HTTP client for communicating with the CC5 Python bridge plugin.
 */

import type {
  CC5Avatar,
  CC5Response,
  MorphCatalog,
  AvatarInfo,
  OperationResult,
  CreateAvatarResult,
  DeleteAvatarResult,
  CaptureResult,
  MorphSetRequest,
  CameraInfo,
  FocalLengthResult,
  LightInfo,
  LightColorResult,
  LightDetailInfo,
  LightMultiplierResult,
  LightActiveResult,
  LightShadowResult,
  VisualSettings,
  SetAmbientResult,
  SetIblResult,
  ExpressionInfo,
  ExpressionItem,
  ExpressionSetResult,
  ExpressionResetResult,
  ResetMorphsResult,
  MaterialInfo,
  DiffuseColor,
  SetDiffuseColorResult,
  MaterialProperties,
  SetMaterialPropertyResult,
  ShaderParameters,
  SetShaderParameterResult,
  ClothingItem,
  HairItem,
  AccessoryItem,
  RemoveItemResult,
  ColorResult,
  SetVisibleResult,
  SceneObject,
  ExportFbxOptions,
  ExportFbxResult,
  BakeSkinResult,
  ExportHeadMetaHumanResult,
  CreateActorMixerOptions,
  CreateActorMixerResult,
  JobStatus,
  MeshStatsResult,
  MeshListResult,
} from "./types.js";
import { getBridgeToken, resetTokenCache } from "./auth.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:5101";
// Must stay above the bridge's 30 s command timeout (cc5-plugin/server.py `_execute_sync`)
// so its 504 "cancelled" / "running" answer arrives before this client gives up.
const _rawTimeout = parseInt(process.env.CC5_REQUEST_TIMEOUT_MS ?? "35000", 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(_rawTimeout) && _rawTimeout > 0 && _rawTimeout <= 300_000
  ? _rawTimeout
  : 35_000;

/** CC5 could not be reached: the connection failed, or no reply came back in time. */
export class BridgeUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BridgeUnreachableError";
  }
}

/** The bridge answered with an HTTP error status. The message is CC5's own error text when the body has one. */
export class BridgeHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BridgeHttpError";
  }
}

function describeFetchFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Node's fetch says only "fetch failed"; the cause names the socket error (e.g. ECONNREFUSED).
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeText = cause instanceof Error ? cause.message : "";
  return causeText && !message.includes(causeText) ? `${message} (${causeText})` : message;
}

/**
 * The bridge answers a failed command with HTTP 400 and the command's {success: false, error} result,
 * and a command timeout with 504 {state: "running" | "cancelled", error}. Surface CC5's own text.
 */
function describeHttpError(status: number, rawBody: string): string {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = undefined;
  }
  const fields = typeof body === "object" && body !== null ? (body as { error?: unknown; state?: unknown }) : {};
  if (typeof fields.error !== "string" || !fields.error) {
    return `CC5 bridge error (${status}): ${rawBody}`;
  }
  if (status === 504) {
    const state = fields.state === "running" ? "still running" : typeof fields.state === "string" ? fields.state : "unknown state";
    return `CC5 timed out (${state}): ${fields.error}`;
  }
  return fields.error;
}

/** The entry browse_content appends when more files matched than its 200-file cap. */
export function isBrowseTruncation(entry: string): boolean {
  return entry.startsWith("(truncated");
}

export class CC5Bridge {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    const url = baseUrl ?? process.env.CC5_BRIDGE_URL ?? DEFAULT_BASE_URL;
    try {
      const parsed = new URL(url);
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
        throw new Error(`CC5_BRIDGE_URL must point to localhost, got: ${parsed.hostname}`);
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error(`Invalid CC5_BRIDGE_URL: ${url}`);
      }
      throw e;
    }
    this.baseUrl = url;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = getBridgeToken();
      if (token) headers["X-CC5-Token"] = token;
      const options: RequestInit = { method, headers, signal: controller.signal };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, options);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") {
          throw new BridgeUnreachableError(
            `No reply from CC5 within ${REQUEST_TIMEOUT_MS / 1000}s. CC5 may still be running this command; ` +
            "check the scene (list_avatars / capture_viewport) before retrying.");
        }
        throw new BridgeUnreachableError(describeFetchFailure(err), { cause: err });
      }

      if (response.status === 401) {
        resetTokenCache();
        throw new BridgeHttpError(
          "CC5 rejected the bridge token. Start Character Creator 5 at least once so it writes its token, then try again", 401);
      }

      if (!response.ok) {
        throw new BridgeHttpError(describeHttpError(response.status, await response.text()), response.status);
      }

      const data = (await response.json()) as CC5Response<T>;

      if (data.error) {
        throw new Error(`CC5 error: ${data.error}`);
      }

      if (data.result === undefined) {
        throw new Error("CC5 bridge returned empty result");
      }

      return data.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<{ status: string }>("/health");
      return true;
    } catch (err) {
      console.error("[CC5 Bridge] healthCheck failed:", err);
      return false;
    }
  }

  async getAvatars(): Promise<CC5Avatar[]> {
    return this.request<CC5Avatar[]>("/avatars");
  }

  async getAvatarInfo(): Promise<AvatarInfo | null> {
    return this.request<AvatarInfo | null>("/avatar/info");
  }

  async searchMorphs(query: string, category?: string): Promise<Array<{ id: string; display_name: string; category: string }>> {
    return this.request<Array<{ id: string; display_name: string; category: string }>>("/morphs/search", "POST", {
      query,
      category: category ?? "",
    });
  }

  async getMorphCatalog(): Promise<MorphCatalog> {
    return this.request<MorphCatalog>("/morphs/catalog");
  }

  async getMorphValue(
    morphId: string,
  ): Promise<{ success: boolean; morph_id?: string; value?: number; error?: string }> {
    return this.request("/morph/get", "POST", {
      morph_id: morphId,
    });
  }

  async setMorph(morphId: string, value: number): Promise<OperationResult> {
    return this.request<OperationResult>("/morph/set", "POST", {
      morph_id: morphId,
      value,
    });
  }

  async setMultipleMorphs(
    morphs: MorphSetRequest[]
  ): Promise<OperationResult> {
    return this.request<OperationResult>("/morphs/set", "POST", { morphs });
  }

  async createDefaultAvatar(): Promise<CreateAvatarResult> {
    return this.request<CreateAvatarResult>("/avatar/create", "POST", {});
  }

  async deleteAvatar(name: string): Promise<DeleteAvatarResult> {
    return this.request<DeleteAvatarResult>("/avatar/delete", "POST", { name });
  }

  async loadAsset(filePath: string): Promise<OperationResult> {
    return this.request<OperationResult>("/asset/load", "POST", {
      file_path: filePath,
    });
  }

  async exportFbx(
    outputPath: string,
    options: number = 0,
    extra: ExportFbxOptions = {},
  ): Promise<ExportFbxResult> {
    const body: Record<string, unknown> = {
      output_path: outputPath,
      options,
    };
    if (extra.target_tool !== undefined) body.target_tool = extra.target_tool;
    if (extra.sub_d_level !== undefined) body.sub_d_level = extra.sub_d_level;
    if (extra.include_current_pose !== undefined) body.include_current_pose = extra.include_current_pose;
    if (extra.delete_hidden_faces !== undefined) body.delete_hidden_faces = extra.delete_hidden_faces;
    if (extra.use_smooth_mesh !== undefined) body.use_smooth_mesh = extra.use_smooth_mesh;
    if (extra.remove_eyelash !== undefined) body.remove_eyelash = extra.remove_eyelash;
    if (extra.remove_tearline_occlusion !== undefined) body.remove_tearline_occlusion = extra.remove_tearline_occlusion;
    if (extra.embed_textures !== undefined) body.embed_textures = extra.embed_textures;
    if (extra.export_motion !== undefined) body.export_motion = extra.export_motion;
    if (extra.fps !== undefined) body.fps = extra.fps;
    if (extra.motion_range !== undefined) body.motion_range = extra.motion_range;
    if (extra.convert_image_format !== undefined) body.convert_image_format = extra.convert_image_format;
    if (extra.texture_size !== undefined) body.texture_size = extra.texture_size;
    return this.request<ExportFbxResult>("/export/fbx", "POST", body);
  }

  // --- Mesh-to-MetaHuman pipeline ---

  async bakeSkinTextures(resolution: number = 4096): Promise<BakeSkinResult> {
    return this.request<BakeSkinResult>("/skin/bake", "POST", { resolution });
  }

  async exportHeadMetaHuman(
    outputDir: string,
    characterName: string,
    gender: "Male" | "Female" = "Female",
  ): Promise<ExportHeadMetaHumanResult> {
    return this.request<ExportHeadMetaHumanResult>("/export/head_mh", "POST", {
      output_dir: outputDir,
      character_name: characterName,
      gender,
    });
  }

  async captureViewport(outputPath?: string, width?: number, height?: number): Promise<CaptureResult> {
    const body: Record<string, unknown> = {};
    if (outputPath) body.output_path = outputPath;
    if (width !== undefined) body.width = width;
    if (height !== undefined) body.height = height;
    return this.request<CaptureResult>("/viewport/capture", "POST", body);
  }

  async setSubdivisionLevel(level: number): Promise<OperationResult> {
    return this.request<OperationResult>("/subdivision", "POST", { level });
  }

  // --- Undo / Redo ---

  async undo(): Promise<OperationResult> {
    return this.request<OperationResult>("/undo", "POST", {});
  }

  async redo(): Promise<OperationResult> {
    return this.request<OperationResult>("/redo", "POST", {});
  }

  // --- Camera ---

  async getCameraInfo(): Promise<CameraInfo> {
    return this.request<CameraInfo>("/camera/info");
  }

  async setCameraFocalLength(focalLength: number): Promise<FocalLengthResult> {
    return this.request<FocalLengthResult>("/camera/focal", "POST", {
      focal_length: focalLength,
    });
  }

  async frameCamera(
    view: string,
  ): Promise<{ success: boolean; view?: string; camera?: string; error?: string }> {
    return this.request("/camera/frame", "POST", { view });
  }

  // --- Lights ---

  async getLights(): Promise<LightInfo[]> {
    return this.request<LightInfo[]>("/lights");
  }

  async setLightColor(
    lightName: string,
    r: number,
    g: number,
    b: number
  ): Promise<LightColorResult> {
    return this.request<LightColorResult>("/light/color", "POST", {
      light_name: lightName,
      r,
      g,
      b,
    });
  }

  async getLightInfo(lightName: string): Promise<LightDetailInfo> {
    return this.request<LightDetailInfo>("/light/info", "POST", {
      light_name: lightName,
    });
  }

  async setLightMultiplier(
    lightName: string,
    multiplier: number
  ): Promise<LightMultiplierResult> {
    return this.request<LightMultiplierResult>("/light/multiplier", "POST", {
      light_name: lightName,
      multiplier,
    });
  }

  async setLightActive(
    lightName: string,
    active: boolean
  ): Promise<LightActiveResult> {
    return this.request<LightActiveResult>("/light/active", "POST", {
      light_name: lightName,
      active,
    });
  }

  async setLightShadow(
    lightName: string,
    castShadow: boolean | null,
    darkenStrength: number | null
  ): Promise<LightShadowResult> {
    return this.request<LightShadowResult>("/light/shadow", "POST", {
      light_name: lightName,
      cast_shadow: castShadow,
      darken_strength: darkenStrength,
    });
  }

  // --- Environment / Visual Settings ---

  async getVisualSettings(): Promise<VisualSettings> {
    return this.request<VisualSettings>("/visual/settings");
  }

  async setAmbient(r: number, g: number, b: number): Promise<SetAmbientResult> {
    return this.request<SetAmbientResult>("/visual/ambient", "POST", { r, g, b });
  }

  async setIbl(imagePath: string, enable: boolean): Promise<SetIblResult> {
    return this.request<SetIblResult>("/visual/ibl", "POST", {
      image_path: imagePath,
      enable,
    });
  }

  // --- Expressions ---

  async getExpressionInfo(): Promise<ExpressionInfo> {
    return this.request<ExpressionInfo>("/expressions");
  }

  async setExpression(
    expressions: ExpressionItem[]
  ): Promise<ExpressionSetResult> {
    return this.request<ExpressionSetResult>("/expression/set", "POST", {
      expressions,
    });
  }

  async resetExpression(): Promise<ExpressionResetResult> {
    return this.request<ExpressionResetResult>("/expression/reset", "POST", {});
  }

  // --- Reset Morphs ---

  async resetAllMorphs(avatarName?: string): Promise<ResetMorphsResult> {
    const body: Record<string, unknown> = {};
    if (avatarName) body.avatar_name = avatarName;
    return this.request<ResetMorphsResult>("/morphs/reset", "POST", body);
  }

  // --- Material / Texture ---

  async getMaterialInfo(avatarName?: string): Promise<MaterialInfo> {
    const body: Record<string, unknown> = {};
    if (avatarName) body.avatar_name = avatarName;
    return this.request<MaterialInfo>("/material/info", "POST", body);
  }

  async getDiffuseColor(meshName: string, materialName: string): Promise<DiffuseColor> {
    return this.request<DiffuseColor>("/material/color/get", "POST", {
      mesh_name: meshName,
      material_name: materialName,
    });
  }

  async setDiffuseColor(
    meshName: string,
    materialName: string,
    r: number,
    g: number,
    b: number
  ): Promise<SetDiffuseColorResult> {
    return this.request<SetDiffuseColorResult>("/material/color/set", "POST", {
      mesh_name: meshName,
      material_name: materialName,
      r,
      g,
      b,
    });
  }

  async getMaterialProperties(
    meshName: string,
    materialName: string
  ): Promise<MaterialProperties> {
    return this.request<MaterialProperties>("/material/properties", "POST", {
      mesh_name: meshName,
      material_name: materialName,
    });
  }

  async setMaterialOpacity(
    meshName: string,
    materialName: string,
    opacity: number
  ): Promise<SetMaterialPropertyResult> {
    return this.request<SetMaterialPropertyResult>("/material/opacity", "POST", {
      mesh_name: meshName,
      material_name: materialName,
      opacity,
    });
  }

  async setMaterialGlossiness(
    meshName: string,
    materialName: string,
    glossiness: number
  ): Promise<SetMaterialPropertyResult> {
    return this.request<SetMaterialPropertyResult>("/material/glossiness", "POST", {
      mesh_name: meshName,
      material_name: materialName,
      glossiness,
    });
  }

  async setMaterialSpecular(
    meshName: string,
    materialName: string,
    specular: number
  ): Promise<SetMaterialPropertyResult> {
    return this.request<SetMaterialPropertyResult>("/material/specular", "POST", {
      mesh_name: meshName,
      material_name: materialName,
      specular,
    });
  }

  async getShaderParameters(
    meshName: string,
    materialName: string
  ): Promise<ShaderParameters> {
    return this.request<ShaderParameters>("/material/shader/get", "POST", {
      mesh_name: meshName,
      material_name: materialName,
    });
  }

  async setShaderParameter(
    meshName: string,
    materialName: string,
    parameterName: string,
    values: number[]
  ): Promise<SetShaderParameterResult> {
    return this.request<SetShaderParameterResult>("/material/shader/set", "POST", {
      mesh_name: meshName,
      material_name: materialName,
      parameter_name: parameterName,
      values,
    });
  }

  // --- Content Management (Tier 1) ---

  async listClothes(): Promise<ClothingItem[]> {
    return this.request<ClothingItem[]>("/clothes");
  }

  async listHair(): Promise<HairItem[]> {
    return this.request<HairItem[]>("/hair");
  }

  async listAccessories(): Promise<AccessoryItem[]> {
    return this.request<AccessoryItem[]>("/accessories");
  }

  async removeSceneItem(itemName: string): Promise<RemoveItemResult> {
    return this.request<RemoveItemResult>("/item/remove", "POST", {
      item_name: itemName,
    });
  }

  /**
   * Content files of one category. With `query`, CC5 keeps only file names containing every word, before
   * its 200-file cap. A list cut at the cap ends with a "(truncated: ..." entry (see isBrowseTruncation).
   */
  async browseContent(folderType: string, query?: string): Promise<string[]> {
    const body: Record<string, unknown> = { folder_type: folderType };
    if (query) body.query = query;
    return this.request<string[]>("/content/browse", "POST", body);
  }

  // --- Convenience Color Shortcuts (Tier 3) ---

  async setEyeColor(r: number, g: number, b: number): Promise<ColorResult> {
    return this.request<ColorResult>("/color/eye", "POST", { r, g, b });
  }

  async setHairColor(r: number, g: number, b: number): Promise<ColorResult> {
    return this.request<ColorResult>("/color/hair", "POST", { r, g, b });
  }

  async setLipColor(r: number, g: number, b: number): Promise<ColorResult> {
    return this.request<ColorResult>("/color/lip", "POST", { r, g, b });
  }

  async setSkinColor(r: number, g: number, b: number): Promise<ColorResult> {
    return this.request<ColorResult>("/color/skin", "POST", { r, g, b });
  }

  // --- Visibility & Scene (Tier 4) ---

  async setItemVisible(itemName: string, visible: boolean): Promise<SetVisibleResult> {
    return this.request<SetVisibleResult>("/item/visible", "POST", {
      item_name: itemName,
      visible,
    });
  }

  async getSceneObjects(): Promise<SceneObject[]> {
    return this.request<SceneObject[]>("/scene/objects");
  }

  async execPython(code: string): Promise<{ success: boolean; output?: string; result?: string; error?: string }> {
    return this.request<{ success: boolean; output?: string; result?: string; error?: string }>("/exec/python", "POST", { code });
  }

  // --- ActorMIXER PRO: Create Mixer Assets ---

  async createActorMixer(opts: CreateActorMixerOptions): Promise<CreateActorMixerResult> {
    const body: Record<string, unknown> = {
      confirm_create: opts.confirm_create ?? false,
    };
    if (opts.morph_name !== undefined) body.morph_name = opts.morph_name;
    if (opts.slider_path !== undefined) body.slider_path = opts.slider_path;
    if (opts.use_parts_folder !== undefined) body.use_parts_folder = opts.use_parts_folder;
    if (opts.head_parts !== undefined) body.head_parts = opts.head_parts;
    if (opts.body_parts !== undefined) body.body_parts = opts.body_parts;
    if (opts.save_presets !== undefined) body.save_presets = opts.save_presets;
    if (opts.save_avatar_presets !== undefined) body.save_avatar_presets = opts.save_avatar_presets;
    return this.request<CreateActorMixerResult>("/actor_mixer/create", "POST", body);
  }

  // --- Jobs: long operations polled to completion ---

  async startJob(action: string, params: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.request<{ job_id: string }>("/jobs/start", "POST", { action, params });
  }

  async getJob(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>("/jobs/status", "POST", { job_id: jobId });
  }

  // --- Pipeline ---

  async getMeshStats(): Promise<MeshStatsResult> {
    return this.request<MeshStatsResult>("/pipeline/mesh_stats", "POST", {});
  }

  async applyPose(filePath: string): Promise<OperationResult & { method?: string }> {
    return this.request("/pipeline/pose", "POST", { file_path: filePath });
  }

  async saveCharacter(outputPath: string): Promise<OperationResult & { path?: string }> {
    return this.request("/pipeline/save_character", "POST", { output_path: outputPath });
  }

  async exportObj(outputPath: string, yUp: boolean = true): Promise<OperationResult & { path?: string; signature?: string }> {
    return this.request("/pipeline/export_obj", "POST", { output_path: outputPath, y_up: yUp });
  }

  async listMeshes(): Promise<MeshListResult> {
    return this.request<MeshListResult>("/pipeline/meshes", "POST", {});
  }

  async replaceMeshFromObj(meshName: string, objPath: string): Promise<OperationResult> {
    return this.request<OperationResult>("/pipeline/replace_mesh", "POST", { mesh_name: meshName, obj_path: objPath });
  }

  async loadTexture(meshName: string, materialName: string, channel: string, imagePath: string): Promise<OperationResult> {
    return this.request("/pipeline/load_texture", "POST",
      { mesh_name: meshName, material_name: materialName, channel, image_path: imagePath });
  }

  async loadSubstanceTextures(folder: string): Promise<OperationResult> {
    return this.request("/pipeline/substance_import", "POST", { folder });
  }

  async applySkinOverlay(imagePath: string, region: string, strength: number): Promise<OperationResult & { applied_to?: string[] }> {
    return this.request("/skin/overlay", "POST", { image_path: imagePath, region, strength });
  }

  async removeSkinOverlay(region: string): Promise<OperationResult & { removed_from?: string[]; no_overlay?: string[] }> {
    return this.request("/skin/overlay/remove", "POST", { region });
  }

  async setSkinCondition(condition: string, amount: number, region: string, baseRgb?: [number, number, number]): Promise<OperationResult & { applied_to?: string[] }> {
    return this.request("/skin/condition", "POST", { condition, amount, region, base_rgb: baseRgb });
  }

  async setWrinkleStrength(strength: number): Promise<OperationResult> {
    return this.request("/skin/wrinkle", "POST", { strength });
  }

  async loadFacialProfile(filePath: string): Promise<OperationResult> {
    return this.request("/builder/facial_profile", "POST", { file_path: filePath });
  }
}
