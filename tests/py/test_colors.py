"""Colours go to CC5 on its 0-255 steps, rounded to the nearest step (F-14)."""
from __future__ import annotations

import unittest
from unittest import mock

import _support

HEAD = ("CC_Base_Body", "Std_Skin_Head")


class Cc5RgbTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")

    def _stored(self, value):
        """What CC5 keeps when it truncates the 0-255 value (the live behaviour: 0.3 -> 76)."""
        self.api._cc5_rgb(value, 0, 0)
        return int(self.rl.RRgb.call_args.args[0] * 255)

    def test_rounds_to_the_nearest_step_where_cc5_truncated(self):
        # Live: set_ambient 0.3 was stored as 76 (0.298) and 0.1 as 25 (0.098).
        self.assertEqual(self._stored(0.3), 77)
        self.assertEqual(self._stored(0.1), 26)
        self.assertEqual(self._stored(0.9), 230)

    def test_exact_steps_and_the_ends_are_kept(self):
        self.assertEqual(self._stored(76 / 255), 76)
        self.assertEqual(self._stored(0.0), 0)
        self.api._cc5_rgb(1.0, 1.0, 1.0)
        self.assertEqual(self.rl.RRgb.call_args.args, (1.0, 1.0, 1.0))

    def test_rounding_also_lands_on_the_step(self):
        # If CC5 rounds instead of truncating, the value sent still lands on the same step.
        self.api._cc5_rgb(0.3, 0, 0)
        self.assertEqual(round(self.rl.RRgb.call_args.args[0] * 255), 77)

    def test_out_of_range_is_clamped(self):
        self.api._cc5_rgb(-1, 2, 0.5)
        r, g, _b = self.rl.RRgb.call_args.args
        self.assertEqual((r, g), (0.4 / 255, 1.0))


class _CharacterTestCase(unittest.TestCase):
    """A character (id 7) with skin, eyelash and lip materials on CC_Base_Body and a hair mesh."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.avatar.GetID.return_value = 7
        self.avatar.GetMeshNames.return_value = ["CC_Base_Body", "Hair_Short"]
        materials = {"CC_Base_Body": ["Std_Skin_Head", "Std_Skin_Body", "Std_Eyelash", "Std_Lip_Mat"],
                     "Hair_Short": ["Hair_Transparency"]}
        self.mat = self.avatar.GetMaterialComponent.return_value
        self.mat.GetMaterialNames.side_effect = lambda mesh: materials[mesh]
        self.avatar.GetHairs.return_value = []
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)


class ColourWriteRecordTest(_CharacterTestCase):
    """F-90 (live): CC5 reports a material's colour as it was when it last rendered, so every setter that writes a
    diffuse colour records it, on the 0-255 steps CC5 reads after a render (cc5_api._writes_since_render). The F-34
    comparison of the next load uses that record (tests/py/test_changes.py)."""

    def assertRecorded(self, rgb, *materials):
        """The record holds exactly `materials` ((mesh, material) pairs), each with the colour's 0-255 steps."""
        expected = {("7", mesh, material): {"diffuse": list(rgb)} for mesh, material in materials}
        self.assertEqual(self.api._writes_since_render, expected)

    def test_set_diffuse_color_records_the_step_cc5_keeps(self):
        self.assertTrue(self.api.set_diffuse_color(*HEAD, 0.4, 0.2, 0.8)["success"])
        self.assertRecorded((102, 51, 204), HEAD)
        # Clamped to 0-1 as it is sent; a later write replaces the earlier one.
        self.api.set_diffuse_color(*HEAD, 1.5, -0.2, 0.2)
        self.assertRecorded((255, 0, 51), HEAD)

    def test_set_skin_color_records_every_skin_material_it_wrote(self):
        r = self.api.set_skin_color(0.8, 0.6, 0.5)  # live: read 0.8, 0.6, 0.502 after a render
        self.assertEqual(r["applied_to"], ["CC_Base_Body/Std_Skin_Head", "CC_Base_Body/Std_Skin_Body"])
        self.assertRecorded((204, 153, 128), HEAD, ("CC_Base_Body", "Std_Skin_Body"))

    def test_set_hair_color_records_hair_meshes_and_hair_items_under_the_character(self):
        hair = mock.MagicMock()
        hair.GetMeshNames.return_value = ["Buzz_Cut"]
        hair.GetMaterialComponent.return_value.GetMaterialNames.return_value = ["Buzz_Cut_Mat"]
        self.avatar.GetHairs.return_value = [hair]
        self.assertTrue(self.api.set_hair_color(0.2, 0.4, 0.0)["success"])
        hair.GetMaterialComponent.return_value.AddDiffuseKey.assert_called_once()
        # The F-34 comparison reads a hair item's materials through the character, so they are recorded under it.
        self.assertRecorded((51, 102, 0), ("Hair_Short", "Hair_Transparency"), ("Buzz_Cut", "Buzz_Cut_Mat"))

    def test_set_lip_color_records_the_lip_material(self):
        self.assertTrue(self.api.set_lip_color(0.4, 0.2, 0.2)["success"])
        self.assertRecorded((102, 51, 51), ("CC_Base_Body", "Std_Lip_Mat"))

    def test_a_write_cc5_refused_is_not_recorded(self):
        def add(key, mesh, material, color):
            if material == "Std_Skin_Body":
                raise RuntimeError("SWIG")

        self.mat.AddDiffuseKey.side_effect = add
        r = self.api.set_skin_color(0.8, 0.6, 0.5)
        self.assertEqual(r["applied_to"], ["CC_Base_Body/Std_Skin_Head"])
        self.assertRecorded((204, 153, 128), HEAD)

    def test_a_record_that_cannot_be_kept_never_fails_the_setter(self):
        self.avatar.GetID.side_effect = RuntimeError("SWIG")
        self.assertTrue(self.api.set_skin_color(0.8, 0.6, 0.5)["success"])
        self.assertEqual(self.api._writes_since_render, {})


class _Colour:
    """What GetDiffuseColor returns: CC5's 0-255 channels."""

    def __init__(self, r, g, b):
        self.rgb = (r, g, b)

    def Red(self):
        return self.rgb[0]

    def Green(self):
        return self.rgb[1]

    def Blue(self):
        return self.rgb[2]


class GetDiffuseColorTest(_CharacterTestCase):
    """Review #0 (F-90, live): right after set_skin_color, GetDiffuseColor still gave the colour from before the write,
    until CC5 rendered. get_diffuse_color gives a colour the bridge set since then from its record, and says so."""

    NOTE = ("This is the colour the bridge set. CC5 reports a material's colour only after it next renders "
            "(capture_viewport), so its own read may still give the colour from before (F-90).")

    def setUp(self):
        super().setUp()
        self.mat.GetDiffuseColor.return_value = _Colour(255, 255, 255)  # what CC5 reported at its last render

    def test_a_colour_the_bridge_just_set_comes_from_its_record_with_a_note(self):
        self.assertTrue(self.api.set_diffuse_color(*HEAD, 0.4, 0.2, 0.8)["success"])
        r = self.api.get_diffuse_color(*HEAD)
        self.assertEqual(r, {"success": True, "r": 102 / 255.0, "g": 51 / 255.0, "b": 204 / 255.0,
                             "notes": [self.NOTE]})
        self.assertEqual(self.api.DIFFUSE_FROM_RECORD, self.NOTE)
        self.mat.GetDiffuseColor.assert_not_called()

    def test_a_colour_the_bridge_has_no_record_of_is_cc5s_read(self):
        self.api.set_diffuse_color("CC_Base_Body", "Std_Skin_Body", 0.1, 0.1, 0.1)  # another material's record
        self.mat.GetDiffuseColor.return_value = _Colour(204, 153, 128)
        r = self.api.get_diffuse_color(*HEAD)
        self.assertEqual(r, {"success": True, "r": 204 / 255.0, "g": 153 / 255.0, "b": 128 / 255.0})
        self.mat.GetDiffuseColor.assert_called_once_with(*HEAD)

    def test_after_a_render_cleared_the_record_cc5s_read_is_used_again(self):
        self.api.set_diffuse_color(*HEAD, 0.4, 0.2, 0.8)
        self.api._forget_writes()  # what a capture that rendered does
        self.mat.GetDiffuseColor.return_value = _Colour(102, 51, 204)
        self.assertNotIn("notes", self.api.get_diffuse_color(*HEAD))

    # Batch F review #3: an undo or a redo empties the record, and CC5 may still report the colour of its last render
    # (review #20: cc5_api._colours_late_since_undo holds the characters an undo or redo found in the scene, and those a
    # load's comparison could not settle). CC5's read of such a character says so.
    LATE = ("CC5 may report this colour as it was at its last render: an undo, a redo or a load since then may have "
            "changed it, and CC5 reports a material's colour only after it next renders. Take a capture "
            "(capture_viewport) first, then read it again (F-90).")

    def test_after_an_undo_or_a_redo_cc5s_read_comes_with_a_note(self):
        self.rl.RScene.GetAvatars.return_value = [self.avatar]  # the character in the scene at the undo or redo
        self.mat.GetDiffuseColor.return_value = _Colour(204, 153, 128)  # what CC5 reported at its last render
        read = {"success": True, "r": 204 / 255.0, "g": 153 / 255.0, "b": 128 / 255.0}
        for step in ("undo", "redo"):
            with self.subTest(step):
                self.api._clear_colours_late()  # what a capture that rendered does
                self.assertEqual(self.api.get_diffuse_color(*HEAD), read)
                self.assertTrue(getattr(self.api, step)()["success"])
                self.assertEqual(self.api.get_diffuse_color(*HEAD), {**read, "notes": [self.LATE]})
        self.assertEqual(self.api.DIFFUSE_READ_MAY_BE_LATE, self.LATE)

    def test_the_note_is_for_a_character_the_undo_marked_and_the_record_comes_first(self):
        self.rl.RScene.GetAvatars.return_value = [self.avatar]
        self.assertTrue(self.api.undo()["success"])
        # A colour set after the undo comes from the record, with its own note.
        self.api.set_diffuse_color(*HEAD, 0.4, 0.2, 0.8)
        self.assertEqual(self.api.get_diffuse_color(*HEAD)["notes"], [self.NOTE])
        # Another character was in the scene at the undo, not this one: CC5's read stands alone.
        self.api._clear_colours_late()
        self.api._colours_late_since_undo.add("8")
        self.mat.GetDiffuseColor.return_value = _Colour(10, 20, 30)
        self.assertEqual(self.api.get_diffuse_color("CC_Base_Body", "Std_Skin_Body"),
                         {"success": True, "r": 10 / 255.0, "g": 20 / 255.0, "b": 30 / 255.0})


if __name__ == "__main__":
    unittest.main()
