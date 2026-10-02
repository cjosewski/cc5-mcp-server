from __future__ import annotations

import unittest
from unittest import mock

import _support


def _mesh(name, v, f, corners=4):
    """A fake RIMesh. Live CC5 meshes are quads: GetFace(i) returns the face's 4 vertex indices."""
    m = mock.MagicMock()
    m.GetName.return_value = name
    m.GetVerticesCount.return_value = v
    m.GetFacesCount.return_value = f
    m.GetFace.return_value = list(range(corners))
    return m


def _obj(name, meshes, mats_per_mesh):
    o = mock.MagicMock()
    o.GetName.return_value = name
    o.GetMeshes.return_value = meshes
    o.GetMaterialComponent.return_value.GetMaterialNames.return_value = ["m"] * mats_per_mesh
    return o


class MeshStatsTest(unittest.TestCase):
    def setUp(self):
        self.pipe = _support.fresh_import("cc5_pipeline")

    def _stats(self, avatar):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=avatar):
            return self.pipe.get_mesh_stats()

    def test_no_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None):
            self.assertFalse(self.pipe.get_mesh_stats()["success"])

    def test_totals_across_body_clothes_hair(self):
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        r = self._stats(avatar)
        self.assertTrue(r["success"])
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "triangles": 47800, "materials": 9})
        self.assertEqual([m["kind"] for m in r["meshes"]], ["body", "clothing", "hair"])

    def test_worn_meshes_in_avatar_list_counted_once(self):
        # GetMeshes(True) on the avatar may also return worn-item meshes (child nodes).
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000), _mesh("Shirt", 3000, 2900), _mesh("Hair", 9000, 8000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        r = self._stats(avatar)
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "triangles": 47800, "materials": 9})
        self.assertEqual([(m["kind"], m["mesh"]) for m in r["meshes"]], [("body", "CC_Base_Body"), ("clothing", "Shirt"), ("hair", "Hair")])

    def test_counts_triangles_from_each_face_not_polygons(self):
        # Quads give 2 triangles, triangles 1, an n-gon n - 2. GetFacesCount alone under-counts by about 2x.
        body = _mesh("CC_Base_Body", 100, 3)
        body.GetFace.side_effect = lambda i: [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9, 10, 11]][i]
        avatar = _obj("Patient", [body], 1)
        avatar.GetClothes.return_value = avatar.GetHairs.return_value = avatar.GetAccessories.return_value = []
        r = self._stats(avatar)
        self.assertEqual((r["totals"]["faces"], r["totals"]["triangles"]), (3, 6))
        self.assertNotIn("approximate", r["meshes"][0])

    def test_estimates_two_triangles_per_polygon_when_faces_cannot_be_read(self):
        body = _mesh("CC_Base_Body", 100, 500)
        body.GetFace.side_effect = TypeError("in method 'RIMesh_GetFace'")
        avatar = _obj("Patient", [body], 1)
        avatar.GetClothes.return_value = avatar.GetHairs.return_value = avatar.GetAccessories.return_value = []
        r = self._stats(avatar)
        self.assertEqual(r["totals"]["triangles"], 1000)
        self.assertTrue(r["meshes"][0]["approximate"])

    def test_two_garments_with_the_same_mesh_name_both_count(self):
        # Garments made in Blender often keep generic mesh names; one must not hide the other's triangles.
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 15000, 15000)], 6)
        avatar.GetClothes.return_value = [_obj("Jacket", [_mesh("Mesh", 10000, 10000)], 1),
                                          _obj("Trousers", [_mesh("Mesh", 10000, 10000)], 1)]
        avatar.GetHairs.return_value = avatar.GetAccessories.return_value = []
        r = self._stats(avatar)
        self.assertEqual(r["totals"], {"vertices": 35000, "faces": 35000, "triangles": 70000, "materials": 8})
        self.assertEqual([(m["object"], m["mesh"]) for m in r["meshes"]],
                         [("Patient", "CC_Base_Body"), ("Jacket", "Mesh"), ("Trousers", "Mesh")])


if __name__ == "__main__":
    unittest.main()
