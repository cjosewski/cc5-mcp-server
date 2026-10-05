"""Colours go to CC5 on its 0-255 steps, rounded to the nearest step (F-14)."""
from __future__ import annotations

import unittest

import _support


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


if __name__ == "__main__":
    unittest.main()
