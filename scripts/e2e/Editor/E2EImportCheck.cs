using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

/// <summary>
/// Batch-mode import check for the CC5 -> Blender -> Unity end-to-end run (scripts/e2e/run_e2e.py).
/// Re-imports each model, then logs per model: importer warnings and errors, renderer counts, triangles,
/// materials and their main textures, rig type, bones, animation clips, and the world positions of the
/// head, hand and foot bones (as imported, and after sampling the first clip at time 0).
/// Writes a JSON report and exits with code 1 if any model failed to import or has no renderers.
///
/// Unity.exe -batchmode -nographics -projectPath P -executeMethod E2EImportCheck.Run -logFile P/e2e-unity.log -quit
///     -e2eModels "Assets/E2E/A/A.fbx;Assets/E2E/B/B.fbx" -e2eReport C:/path/e2e-unity-report.json
/// </summary>
public static class E2EImportCheck
{
    [Serializable]
    public class BonePosition
    {
        public string name;
        public float x;
        public float y;
        public float z;
    }

    [Serializable]
    public class RendererInfo
    {
        public string name;
        public string type;
        public string mesh;
        public int triangles;
        public List<string> materials = new List<string>();
    }

    [Serializable]
    public class MaterialInfo
    {
        public string name;
        public string shader;
        public string mainTexture;
    }

    [Serializable]
    public class ModelReport
    {
        public string path;
        public bool imported;
        public List<string> errors = new List<string>();
        public List<string> warnings = new List<string>();
        public string animationType = "";
        public int skinnedRenderers;
        public int meshRenderers;
        public int triangles;
        public List<RendererInfo> renderers = new List<RendererInfo>();
        public List<MaterialInfo> materials = new List<MaterialInfo>();
        public int materialCount;
        public int materialsWithMainTexture;
        public List<string> missingTextures = new List<string>();
        public int bones;
        public List<string> clips = new List<string>();
        public List<BonePosition> bonesStatic = new List<BonePosition>();
        public bool sampled;
        public List<BonePosition> bonesSampled = new List<BonePosition>();
        public float seconds;
    }

    [Serializable]
    public class Report
    {
        public string unityVersion;
        public bool ok;
        public List<ModelReport> models = new List<ModelReport>();
    }

    // CC3+ skeleton names: what run_e2e.py compares between the unposed and the posed export.
    private static readonly string[] K_PoseBones =
    {
        "CC_Base_Head", "CC_Base_L_Hand", "CC_Base_R_Hand", "CC_Base_L_Foot", "CC_Base_R_Foot",
    };

    public static void Run()
    {
        var report = new Report { unityVersion = Application.unityVersion, ok = true };
        string reportPath = Argument("-e2eReport");
        string models = Argument("-e2eModels");
        if (string.IsNullOrEmpty(reportPath) || string.IsNullOrEmpty(models))
        {
            Debug.LogError("E2EImportCheck: pass -e2eModels \"Assets/a.fbx;Assets/b.fbx\" and -e2eReport <file.json>");
            EditorApplication.Exit(1);
            return;
        }
        foreach (string path in models.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
        {
            ModelReport model = CheckModel(path.Trim());
            report.models.Add(model);
            if (!model.imported || model.skinnedRenderers + model.meshRenderers == 0)
            {
                report.ok = false;
            }
        }
        File.WriteAllText(reportPath, JsonUtility.ToJson(report, true));
        Debug.Log($"E2EImportCheck: wrote {reportPath} (ok={report.ok})");
        EditorApplication.Exit(report.ok ? 0 : 1);
    }

    private static string Argument(string name)
    {
        string[] args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static ModelReport CheckModel(string path)
    {
        var model = new ModelReport { path = path };
        Application.LogCallback onLog = (message, stackTrace, type) =>
        {
            if (type == LogType.Warning)
            {
                model.warnings.Add(message);
            }
            else if (type != LogType.Log)
            {
                model.errors.Add(message);
            }
        };
        var timer = Stopwatch.StartNew();
        Application.logMessageReceived += onLog;
        try
        {
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
        }
        finally
        {
            Application.logMessageReceived -= onLog;
        }
        model.seconds = (float)timer.Elapsed.TotalSeconds;

        var importer = AssetImporter.GetAtPath(path) as ModelImporter;
        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
        if (importer == null || prefab == null)
        {
            model.errors.Add($"Unity did not import {path} as a model");
            return model;
        }
        model.imported = true;
        model.animationType = importer.animationType.ToString();

        GameObject instance = UnityEngine.Object.Instantiate(prefab, Vector3.zero, Quaternion.identity);
        try
        {
            Describe(instance, model);
            model.bonesStatic = BonePositions(instance);
            List<AnimationClip> clips = AssetDatabase.LoadAllAssetRepresentationsAtPath(path)
                .OfType<AnimationClip>()
                .Where(c => !c.name.StartsWith("__preview__", StringComparison.Ordinal))
                .ToList();
            model.clips = clips.Select(c => c.name).ToList();
            if (clips.Count > 0)
            {
                clips[0].SampleAnimation(instance, 0f);
                model.sampled = true;
                model.bonesSampled = BonePositions(instance);
            }
        }
        catch (Exception e)
        {
            model.errors.Add($"Check failed: {e}");
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(instance);
        }
        return model;
    }

    private static void Describe(GameObject instance, ModelReport model)
    {
        var materials = new List<Material>();
        var bones = new HashSet<Transform>();
        foreach (Renderer renderer in instance.GetComponentsInChildren<Renderer>(true))
        {
            Mesh mesh = null;
            if (renderer is SkinnedMeshRenderer skinned)
            {
                model.skinnedRenderers++;
                mesh = skinned.sharedMesh;
                foreach (Transform bone in skinned.bones)
                {
                    if (bone != null)
                    {
                        bones.Add(bone);
                    }
                }
            }
            else if (renderer is MeshRenderer)
            {
                model.meshRenderers++;
                MeshFilter filter = renderer.GetComponent<MeshFilter>();
                mesh = filter != null ? filter.sharedMesh : null;
            }
            else
            {
                continue;
            }
            var info = new RendererInfo
            {
                name = renderer.name,
                type = renderer.GetType().Name,
                mesh = mesh != null ? mesh.name : "",
                triangles = Triangles(mesh),
            };
            foreach (Material material in renderer.sharedMaterials)
            {
                info.materials.Add(material != null ? material.name : "(none)");
                if (material != null && !materials.Contains(material))
                {
                    materials.Add(material);
                }
            }
            model.triangles += info.triangles;
            model.renderers.Add(info);
        }
        foreach (Material material in materials)
        {
            Texture main = material.HasProperty("_MainTex") || material.HasProperty("_BaseMap") ? material.mainTexture : null;
            model.materials.Add(new MaterialInfo
            {
                name = material.name,
                shader = material.shader != null ? material.shader.name : "",
                mainTexture = main != null ? main.name : "",
            });
            if (main != null)
            {
                model.materialsWithMainTexture++;
            }
            else
            {
                model.missingTextures.Add(material.name);
            }
        }
        model.materialCount = materials.Count;
        model.bones = bones.Count;
    }

    private static int Triangles(Mesh mesh)
    {
        if (mesh == null)
        {
            return 0;
        }
        long indices = 0;
        for (int i = 0; i < mesh.subMeshCount; i++)
        {
            if (mesh.GetTopology(i) == MeshTopology.Triangles)
            {
                indices += mesh.GetIndexCount(i);
            }
        }
        return (int)(indices / 3);
    }

    private static List<BonePosition> BonePositions(GameObject instance)
    {
        var result = new List<BonePosition>();
        Transform[] all = instance.GetComponentsInChildren<Transform>(true);
        foreach (string name in K_PoseBones)
        {
            Transform bone = all.FirstOrDefault(t => t.name == name);
            if (bone != null)
            {
                Vector3 p = bone.position;
                result.Add(new BonePosition { name = name, x = p.x, y = p.y, z = p.z });
            }
        }
        return result;
    }
}
