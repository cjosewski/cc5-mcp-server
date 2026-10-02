from __future__ import annotations

import unittest
from unittest import mock

import _support


class BrowseSearchTest(unittest.TestCase):
    """browse_content caps its list at 200 files; a keyword search must filter before that cap."""

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.rl.RApplication.GetDefaultContentFolder.return_value = "$/Upper"
        self.rl.RApplication.GetCustomContentFolder.return_value = ""

    def _listing(self, files):
        self.rl.RApplication.GetContentFilesInFolder.return_value = files

    def test_query_filters_before_the_200_file_cap(self):
        self._listing([f"C:/c/Shirt_{i:03}.ccCloth" for i in range(249)] + ["C:/c/Camo Jacket.ccCloth"])
        self.assertEqual(self.api.browse_content("cloth_upper", "camo jacket"), ["C:/c/Camo Jacket.ccCloth"])

    def test_query_words_match_the_file_name_in_any_order_and_case(self):
        self._listing(["C:/c/Military Jacket CAMO.ccCloth", "C:/camo/Hoodie.ccCloth", "C:/c/Jacket.ccCloth"])
        self.assertEqual(self.api.browse_content("cloth_upper", "camo jacket"), ["C:/c/Military Jacket CAMO.ccCloth"])

    def test_more_than_200_matches_end_with_the_truncation_marker(self):
        self._listing([f"C:/c/Shirt_{i:03}.ccCloth" for i in range(250)])
        r = self.api.browse_content("cloth_upper")
        self.assertEqual(len(r), 201)
        self.assertEqual(r[199], "C:/c/Shirt_199.ccCloth")
        self.assertEqual(r[-1], self.api.BROWSE_TRUNCATED)

    def test_exactly_200_files_are_not_marked_truncated(self):
        self._listing([f"C:/c/Shirt_{i:03}.ccCloth" for i in range(200)])
        r = self.api.browse_content("cloth_upper")
        self.assertEqual(len(r), 200)
        self.assertNotIn(self.api.BROWSE_TRUNCATED, r)

    def test_bridge_passes_the_query(self):
        srv = _support.fresh_import("server")
        with mock.patch.object(srv.cc5_api, "browse_content", return_value=[]) as browse:
            srv.ACTION_MAP["browse_content"]({"folder_type": "shoes", "query": "combat boots"})
            srv.ACTION_MAP["browse_content"]({"folder_type": "shoes"})
        self.assertEqual(browse.call_args_list, [mock.call("shoes", "combat boots"), mock.call("shoes", "")])


if __name__ == "__main__":
    unittest.main()
