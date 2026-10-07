from __future__ import annotations

import os
import tempfile
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

    def test_hair_lists_rlhair_hairstyles_and_eye_lists_eye_presets(self):
        # Live CC5 5.13: every hairstyle is .rlHair; other categories still ignore .rl* files.
        self._listing(["C:/h/Buzz Cut.rlHair", "C:/h/Buzz Cut.rlHairElement", "C:/h/readme.txt"])
        self.assertEqual(self.api.browse_content("hair", "buzz"), ["C:/h/Buzz Cut.rlHair"])
        self.assertEqual(self.api.browse_content("cloth_upper", "buzz"), [])
        self._listing(["C:/e/_Green CH1 Eyes.ccEye"])
        self.assertEqual(self.api.browse_content("eye", "green"), ["C:/e/_Green CH1 Eyes.ccEye"])

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



class BrowseFolderMapTest(unittest.TestCase):
    """Each category reads the CC5 clothing / accessory folders it names (live CC5 5.13 enums, F-41 to F-43)."""

    # Live GetDefaultContentFolder results; the fake RLPy gives each enum a distinct object.
    LIVE = {"Shirts": "$/Cloth/Shirts", "Coats": "$/Cloth/Coats", "Pants": "$/Cloth/Pants",
            "Skirts": "$/Cloth/Skirts", "Underwear": "$/Cloth/Underwear", "Gloves": "$/Cloth/Gloves",
            "ClothOthers": "$/Cloth/Others", "FullBody": "$/Cloth/Full-Body", "Head": "$/Accessory/Head",
            "Torso": "$/Accessory/Torso", "Arm": "$/Accessory/Arm", "Leg": "$/Accessory/Leg",
            "AccessoryOthers": "$/Accessory/Others", "Upper": "$/Actor/Upper", "Lower": "$/Actor/Lower",
            "WrinkleMasks": "$/Others/Skin Textures/Wrinkle References/Wrinkle Mask"}

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        by_enum = {}
        for name, folder in self.LIVE.items():
            enum = object()
            setattr(self.rl, f"EContentRootFolder_{name}", enum)
            by_enum[id(enum)] = folder
        self.rl.RApplication.GetDefaultContentFolder.side_effect = lambda e: by_enum.get(id(e), "")
        self.rl.RApplication.GetCustomContentFolder.return_value = ""
        self.read = []
        self.files = {}
        self.subfolders = {}

        def files_in(folder):
            self.read.append(folder)
            return self.files.get(folder, [])

        self.rl.RApplication.GetContentFilesInFolder.side_effect = files_in
        self.rl.RApplication.GetContentFoldersInFolder.side_effect = lambda f: self.subfolders.get(f, [])

    def _folders(self, category):
        self.read.clear()
        self.api.browse_content(category)
        return list(dict.fromkeys(self.read))

    def test_upper_and_lower_clothing_read_the_clothing_folders(self):
        # Live: cloth_upper read $/Actor/Upper and listed nothing, although Shirts and Coats hold 41 files.
        self.assertEqual(self._folders("cloth_upper"), ["$/Cloth/Shirts", "$/Cloth/Coats"])
        self.assertEqual(self._folders("cloth_lower"), ["$/Cloth/Pants", "$/Cloth/Skirts"])

    def test_accessories_read_the_body_part_folders(self):
        # Live: accessory_head listed a gun, a bow and an axe from Accessory/Others, never the hats.
        self.assertEqual(self._folders("accessory_head"), ["$/Accessory/Head"])
        self.assertEqual(self._folders("accessory_body"), ["$/Accessory/Torso", "$/Accessory/Arm", "$/Accessory/Leg"])
        self.assertEqual(self._folders("accessory_other"), ["$/Accessory/Others"])

    def test_new_clothing_categories(self):
        self.assertEqual(self._folders("underwear"), ["$/Cloth/Underwear"])
        self.assertEqual(self._folders("gloves"), ["$/Cloth/Gloves"])
        self.assertEqual(self._folders("cloth_other"), ["$/Cloth/Others"])
        self.assertEqual(self._folders("cloth"), ["$/Cloth/Full-Body"])

    def test_files_from_every_folder_of_a_category_are_listed(self):
        self.files = {"$/Cloth/Shirts": ["C:/t/Basic T-shirts.ccCloth"], "$/Cloth/Coats": ["C:/t/Long slim coat.ccCloth"]}
        self.assertEqual(self.api.browse_content("cloth_upper"),
                         ["C:/t/Basic T-shirts.ccCloth", "C:/t/Long slim coat.ccCloth"])

    def _template_root_with_wrinkle_masks(self):
        root = tempfile.mkdtemp()
        masks = os.path.join(root, "Others", "Skin Textures", "Wrinkle References", "Wrinkle Mask")
        os.makedirs(masks)
        for name in ("Set 1-1_Brow_Raise.png", "Set 2_Nose_Crease.png", "readme.txt"):
            open(os.path.join(masks, name), "wb").close()
        self.rl.RApplication.GetTemplateDataPath.return_value = root
        return masks.replace("\\", "/")

    def test_wrinkle_masks_cc5_does_not_list_are_read_from_disk(self):
        # Live CC5 5.13: the Wrinkle Mask folder holds 14 PNGs, yet GetContentFilesInFolder listed none of them.
        masks = self._template_root_with_wrinkle_masks()
        self.assertEqual(self.api.browse_content("wrinkle_mask"),
                         [f"{masks}/Set 1-1_Brow_Raise.png", f"{masks}/Set 2_Nose_Crease.png"])
        self.assertEqual(self.api.browse_content("wrinkle_mask", "nose"), [f"{masks}/Set 2_Nose_Crease.png"])

    def test_wrinkle_masks_cc5_lists_are_used_as_they_are(self):
        self._template_root_with_wrinkle_masks()
        self.files = {"$/Others/Skin Textures/Wrinkle References/Wrinkle Mask": ["C:/w/Mask.png"]}
        self.assertEqual(self.api.browse_content("wrinkle_mask"), ["C:/w/Mask.png"])

    def test_other_categories_never_read_the_disk(self):
        # An empty clothing folder stays empty: only the image categories listed in the fallback read the disk.
        # (Custom folders are read from disk, F-72; CC5's template folders are not.)
        self.rl.RApplication.GetTemplateDataPath.return_value = tempfile.mkdtemp()
        self.assertEqual(self.api.browse_content("gloves"), [])
        self.rl.RApplication.GetTemplateDataPath.assert_not_called()


TEMPLATES = ["C:/t/Basic T-shirts.ccCloth", "C:/t/Long slim coat.ccCloth"]


class BrowseCustomContentTest(unittest.TestCase):
    """F-72 (P7-1): CC5's Custom tab never reached browse_content or search_content.

    Live, GetCustomContentFolder(enum) returns a plain path (C:/Users/Public/Documents/Reallusion/Reallusion
    Custom/Cloth/Shirts), and GetContentFilesInFolder lists 0 files for it.
    """

    def setUp(self):
        self.rl = _support.install_fake_rlpy()
        self.api = _support.fresh_import("cc5_api")
        self.enums = {}
        for name in ("Shirts", "Coats", "Pants", "Skirts"):
            enum = object()  # distinct enum objects, as in BrowseFolderMapTest
            setattr(self.rl, f"EContentRootFolder_{name}", enum)
            self.enums[name] = enum
        self.root = tempfile.mkdtemp().replace("\\", "/")
        self.custom_root = f"{self.root}/Reallusion Custom"
        self.shirts = f"{self.custom_root}/Cloth/Shirts"
        os.makedirs(f"{self.shirts}/Camo")
        for name in ("US_Army_Uniform_Shirt.ccCloth", "US Army Uniform Shirt.ccCloth", "desktop.ini", "Shirt.ico",
                     "readme.txt"):
            open(f"{self.shirts}/{name}", "wb").close()
        open(f"{self.shirts}/Camo/Camo Shirt.ccCloth", "wb").close()
        # The Coats custom folder does not exist on disk (the user has no coats of their own).
        self.custom = {"Shirts": self.shirts, "Coats": f"{self.custom_root}/Cloth/Coats"}
        self.default = {"Shirts": "$/Cloth/Shirts", "Coats": "$/Cloth/Coats"}
        app = self.rl.RApplication
        app.GetCustomContentFolder.side_effect = lambda e: self._folder(self.custom, e)
        app.GetDefaultContentFolder.side_effect = lambda e: self._folder(self.default, e)
        app.GetCustomDataPath.return_value = self.custom_root
        self.files = {"$/Cloth/Shirts": ["C:/t/Basic T-shirts.ccCloth"], "$/Cloth/Coats": ["C:/t/Long slim coat.ccCloth"]}
        app.GetContentFilesInFolder.side_effect = lambda f: list(self.files.get(f, []))
        app.GetContentFoldersInFolder.side_effect = lambda f: []

    def _folder(self, table, enum):
        return next((folder for name, folder in table.items() if self.enums[name] is enum), "")

    def _uniform(self):
        return [f"{self.shirts}/US Army Uniform Shirt.ccCloth", f"{self.shirts}/US_Army_Uniform_Shirt.ccCloth"]

    def _browse_reading_disk(self, *args):
        with mock.patch.object(self.api, "_disk_listing", wraps=self.api._disk_listing) as listing:
            result = self.api.browse_content(*args)
        return result, [c.args[0] for c in listing.call_args_list]

    def test_the_users_content_comes_first_read_from_disk(self):
        r = self.api.browse_content("cloth_upper")
        # desktop.ini and Shirt.ico match the .i* filter but are never content; readme.txt is not content either.
        self.assertEqual(r, self._uniform() + [f"{self.shirts}/Camo/Camo Shirt.ccCloth"] + TEMPLATES)
        app = self.rl.RApplication
        asked = {c.args[0] for c in app.GetContentFilesInFolder.call_args_list + app.GetContentFoldersInFolder.call_args_list}
        self.assertEqual(asked, {"$/Cloth/Shirts", "$/Cloth/Coats"})  # never a custom path

    def test_a_search_finds_the_users_uniform(self):
        # Live P7-1: search_content('army') said "No content matched 'army'".
        self.assertEqual(self.api.browse_content("cloth_upper", "army"), self._uniform())

    def test_a_missing_custom_folder_without_templates_lists_nothing(self):
        self.custom["Pants"] = f"{self.custom_root}/Cloth/Pants"
        self.assertEqual(self.api.browse_content("cloth_lower"), [])

    def test_shared_custom_comes_after_the_users_folders_and_before_the_templates(self):
        shared = f"{self.root}/Shared Custom/Cloth/Shirts"
        os.makedirs(shared)
        open(f"{shared}/Shared Vest.ccCloth", "wb").close()
        r, read = self._browse_reading_disk("cloth_upper")
        self.assertEqual(r, self._uniform() + [f"{self.shirts}/Camo/Camo Shirt.ccCloth", f"{shared}/Shared Vest.ccCloth"]
                         + TEMPLATES)
        self.assertEqual([f for f in read if "Shared Templates" in f], [])  # missing on disk: skipped

    def test_the_same_folder_or_file_is_listed_once(self):
        # The same custom folder for two enums, the second time with backslashes and a trailing slash; the same
        # template folder for both; the same file listed twice, in another case and with backslashes.
        self.custom["Coats"] = self.shirts.replace("/", "\\") + "\\"
        self.default["Coats"] = "$/Cloth/Shirts"
        self.files["$/Cloth/Shirts"] = ["C:/t/Basic T-shirts.ccCloth", "C:\\t\\BASIC T-SHIRTS.ccCloth"]
        r, read = self._browse_reading_disk("cloth_upper")
        self.assertEqual(r, self._uniform() + [f"{self.shirts}/Camo/Camo Shirt.ccCloth", "C:/t/Basic T-shirts.ccCloth"])
        self.assertEqual(read, [self.shirts, f"{self.shirts}/Camo"])
        self.rl.RApplication.GetContentFilesInFolder.assert_called_once_with("$/Cloth/Shirts")

    def test_the_custom_root_is_never_walked(self):
        # It holds every category (and stray files at its root): walked as one category, it would list them all.
        open(f"{self.custom_root}/Stray.ccCloth", "wb").close()
        coats = f"{self.custom_root}/Cloth/Coats"
        # The folder GetCustomDataPath names, spelled with a trailing slash.
        data = f"{self.root}/Custom Data"
        os.makedirs(data)
        open(f"{data}/Stray.ccCloth", "wb").close()
        self.rl.RApplication.GetCustomDataPath.return_value = data
        self.custom["Shirts"] = data + "/"
        r, read = self._browse_reading_disk("cloth_upper")
        self.assertEqual((r, read), (TEMPLATES, [coats]))
        # A folder named Reallusion Custom, while GetCustomDataPath fails.
        self.rl.RApplication.GetCustomDataPath.side_effect = RuntimeError("SWIG")
        self.custom["Shirts"] = self.custom_root
        r, read = self._browse_reading_disk("cloth_upper")
        self.assertEqual((r, read), (TEMPLATES, [coats]))

    def test_the_folder_cap_marks_the_list_truncated(self):
        with mock.patch.object(self.api, "MAX_BROWSE_FOLDERS", 1):
            self.assertEqual(self.api.browse_content("cloth_upper"), self._uniform() + [self.api.BROWSE_TRUNCATED])

    def test_a_disk_entry_whose_type_cannot_be_read_is_skipped(self):
        class Entry:
            def __init__(self, name, kind):
                self.name, self.kind = name, kind

            def is_dir(self, follow_symlinks=True):
                if self.kind == "locked":
                    raise PermissionError("access denied")
                return self.kind == "dir"

            def is_file(self):
                return self.kind == "file"

        class Listing:
            def __init__(self, entries):
                self.entries = entries

            def __enter__(self):
                return iter(self.entries)

            def __exit__(self, *exc):
                return False

        entries = [Entry("b.ccCloth", "file"), Entry("Locked", "locked"), Entry("A", "dir")]
        with mock.patch.object(self.api.os, "scandir", return_value=Listing(entries)):
            self.assertEqual(self.api._disk_listing("C:/x"), (["C:/x/b.ccCloth"], ["C:/x/A"]))
        self.assertEqual(self.api._disk_listing(f"{self.root}/missing"), ([], []))


if __name__ == "__main__":
    unittest.main()
