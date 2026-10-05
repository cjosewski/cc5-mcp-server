"""Morph and expression values come back rounded (F-13); reset_expression counts what it changed (F-18)."""
from __future__ import annotations

import unittest
from unittest import mock

import _support


class ExpressionValuesTest(unittest.TestCase):
    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.avatar = mock.MagicMock()
        self.face = self.avatar.GetFaceComponent.return_value
        p = mock.patch.object(self.api, "get_first_avatar", return_value=self.avatar)
        p.start()
        self.addCleanup(p.stop)
        n = mock.patch.object(self.api, "_collect_expression_names",
                              return_value=["Brow_Raise_Inner_L", "Mouth_Smile", "Jaw_Open"])
        n.start()
        self.addCleanup(n.stop)

    def test_morph_value_is_rounded(self):
        # Live: 0.8 read back as 0.800000011920929 (float32).
        self.api._validate_morph_id = lambda morph_id: None
        self.avatar.GetAvatarShapingComponent.return_value.GetShapingMorphWeight.return_value = 0.800000011920929
        self.assertEqual(self.api.get_morph_value("x")["value"], 0.8)

    def test_set_expression_weights_are_rounded(self):
        self.face.GetExpressionWeights.return_value = [0.800000011920929]
        r = self.api.set_expression([{"name": "Mouth_Smile", "weight": 0.8}])
        self.assertEqual(r["applied"], [{"name": "Mouth_Smile", "weight": 0.8}])

    def test_reset_counts_only_the_sliders_that_were_set(self):
        # Live: 172 reported after only 2 sliders were set.
        self.face.GetExpressionWeights.return_value = [0.8, 0.0, 0.5]
        r = self.api.reset_expression()
        self.assertEqual((r["reset_count"], r["reset"], r["slider_count"]), (2, ["Brow_Raise_Inner_L", "Jaw_Open"], 3))
        sent = self.face.AddExpressionKeys.call_args.args
        self.assertEqual((sent[1], sent[2]), (["Brow_Raise_Inner_L", "Mouth_Smile", "Jaw_Open"], [0.0, 0.0, 0.0]))

    def test_reset_falls_back_to_all_when_cc5_cannot_be_read_first(self):
        self.face.GetExpressionWeights.side_effect = RuntimeError("SWIG")
        r = self.api.reset_expression()
        self.assertEqual(r["reset_count"], 3)
        self.assertNotIn("reset", r)


if __name__ == "__main__":
    unittest.main()
