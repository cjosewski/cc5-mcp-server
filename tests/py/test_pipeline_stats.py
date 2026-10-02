from __future__ import annotations

import unittest
from unittest import mock

import _support


def _mesh(name, v, f):
    m = mock.MagicMock()
    m.GetName.return_value = name
    m.GetVerticesCount.return_value = v
    m.GetFacesCount.return_value = f
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

    def test_no_avatar(self):
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=None):
            self.assertFalse(self.pipe.get_mesh_stats()["success"])

    def test_totals_across_body_clothes_hair(self):
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.pipe.get_mesh_stats()
        self.assertTrue(r["success"])
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "materials": 9})
        self.assertEqual([m["kind"] for m in r["meshes"]], ["body", "clothing", "hair"])

    def test_worn_meshes_in_avatar_list_counted_once(self):
        # GetMeshes(True) on the avatar may also return worn-item meshes (child nodes).
        avatar = _obj("Patient", [_mesh("CC_Base_Body", 14000, 13000), _mesh("Shirt", 3000, 2900), _mesh("Hair", 9000, 8000)], 6)
        avatar.GetClothes.return_value = [_obj("Shirt", [_mesh("Shirt", 3000, 2900)], 1)]
        avatar.GetHairs.return_value = [_obj("Hair", [_mesh("Hair", 9000, 8000)], 2)]
        avatar.GetAccessories.return_value = []
        with mock.patch.object(self.pipe.cc5_api, "get_first_avatar", return_value=avatar):
            r = self.pipe.get_mesh_stats()
        self.assertEqual(r["totals"], {"vertices": 26000, "faces": 23900, "materials": 9})
        self.assertEqual([(m["kind"], m["mesh"]) for m in r["meshes"]], [("body", "CC_Base_Body"), ("clothing", "Shirt"), ("hair", "Hair")])
