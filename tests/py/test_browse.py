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

    def test_lists_files_in_subfolders(self):
        # Live CC5: GetContentFilesInFolder does not recurse. Pose, Motion and Texture keep every file in
        # subfolders ($/Animation/Pose/1.Male Pose/...), which GetContentFoldersInFolder lists.
        tree = {"$/Upper": ["$/Upper/A/"], "$/Upper/A/": ["$/Upper/A/Deep/"], "$/Upper/A/Deep/": []}
        files = {"$/Upper": ["C:/u/Root.ccCloth"], "$/Upper/A/": ["C:/u/A/Jacket.ccCloth"],
                 "$/Upper/A/Deep/": ["C:/u/A/Deep/Vest.ccCloth"]}
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: tree[f]
        self.rl.RApplication.GetContentFilesInFolder.side_effect = lambda f: files[f]
        self.assertEqual(self.api.browse_content("cloth_upper"),
                         ["C:/u/Root.ccCloth", "C:/u/A/Jacket.ccCloth", "C:/u/A/Deep/Vest.ccCloth"])

    def test_subfolder_walk_stops_on_a_folder_listing_itself(self):
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: [f, "$/Upper/A/"]
        self.rl.RApplication.GetContentFilesInFolder.side_effect = lambda f: [f"C:/u/{f[-2]}.ccCloth"]
        self.assertEqual(self.api.browse_content("cloth_upper"), ["C:/u/e.ccCloth", "C:/u/A.ccCloth"])

    def test_subfolder_walk_is_bounded(self):
        # A huge library must not stall CC5's main thread: at most MAX_BROWSE_FOLDERS folders are read.
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: [f + "x/"]
        self.rl.RApplication.GetContentFilesInFolder.return_value = []
        self.assertEqual(self.api.browse_content("cloth_upper"), [self.api.BROWSE_TRUNCATED])
        self.assertEqual(self.rl.RApplication.GetContentFilesInFolder.call_count, self.api.MAX_BROWSE_FOLDERS)

    def test_folder_cap_with_unread_folders_left_ends_with_the_truncation_marker(self):
        tree = {"$/Upper": ["$/Upper/A/", "$/Upper/B/"], "$/Upper/A/": [], "$/Upper/B/": []}
        files = {"$/Upper": ["C:/u/Root.ccCloth"], "$/Upper/A/": ["C:/u/A/Jacket.ccCloth"],
                 "$/Upper/B/": ["C:/u/B/Vest.ccCloth"]}
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: tree[f]
        self.rl.RApplication.GetContentFilesInFolder.side_effect = lambda f: files[f]
        with mock.patch.object(self.api, "MAX_BROWSE_FOLDERS", 2):
            self.assertEqual(self.api.browse_content("cloth_upper"),
                             ["C:/u/Root.ccCloth", "C:/u/A/Jacket.ccCloth", self.api.BROWSE_TRUNCATED])

    def test_folder_cap_with_only_visited_folders_left_is_not_marked_truncated(self):
        # $/Upper/A/ lists itself and its parent: both were read already, so nothing was left out.
        tree = {"$/Upper": ["$/Upper/A/"], "$/Upper/A/": ["$/Upper", "$/Upper/A/"]}
        files = {"$/Upper": ["C:/u/Root.ccCloth"], "$/Upper/A/": ["C:/u/A/Jacket.ccCloth"]}
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: tree[f]
        self.rl.RApplication.GetContentFilesInFolder.side_effect = lambda f: files[f]
        with mock.patch.object(self.api, "MAX_BROWSE_FOLDERS", 2):
            self.assertEqual(self.api.browse_content("cloth_upper"), ["C:/u/Root.ccCloth", "C:/u/A/Jacket.ccCloth"])

    def test_cap_counts_files_across_subfolders(self):
        tree = {"$/Upper": ["$/Upper/A/"], "$/Upper/A/": []}
        files = {"$/Upper": [f"C:/u/R_{i:03}.ccCloth" for i in range(150)],
                 "$/Upper/A/": [f"C:/u/A_{i:03}.ccCloth" for i in range(100)]}
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: tree[f]
        self.rl.RApplication.GetContentFilesInFolder.side_effect = lambda f: files[f]
        r = self.api.browse_content("cloth_upper")
        self.assertEqual(len(r), 201)
        self.assertEqual(r[199], "C:/u/A_049.ccCloth")
        self.assertEqual(r[-1], self.api.BROWSE_TRUNCATED)

    def test_bridge_passes_the_query(self):
        srv = _support.fresh_import("server")
        with mock.patch.object(srv.cc5_api, "browse_content", return_value=[]) as browse:
            srv.ACTION_MAP["browse_content"]({"folder_type": "shoes", "query": "combat boots"})
            srv.ACTION_MAP["browse_content"]({"folder_type": "shoes"})
        self.assertEqual(browse.call_args_list, [mock.call("shoes", "combat boots"), mock.call("shoes", "")])


if __name__ == "__main__":
    unittest.main()
