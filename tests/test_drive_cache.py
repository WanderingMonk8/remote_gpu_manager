import ast
import hashlib
import json
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

path = Path(__file__).resolve().parents[1] / "tools" / "drive-cache.py"
spec = importlib.util.spec_from_file_location("drive_cache", path)
drive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drive)
files = [{"id": "id1", "name": "moss_image_sft_int8_convrot.safetensors"},
         {"id": "id2", "name": "qwen3.5_9b_w4a8_gptq.safetensors"},
         {"id": "id3", "name": "flux2-vae_small.safetensors"}]


class Response:
    def __init__(self, name): self.name = name
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def raise_for_status(self): pass
    def json(self): return {"name": self.name, "size": "3", "md5Checksum": hashlib.md5(b"abc").hexdigest()}
    def iter_content(self, _size): yield b"abc"


class DriveCacheTests(unittest.TestCase):
    def test_accepts_partial_safe_selection(self):
        self.assertTrue(drive.build_restore_cell("token", files[:2]))
        with self.assertRaises(ValueError): drive.build_restore_cell("token", files + [{"id":"../bad", "name":"bad"}])

    def test_selected_model_requirements_and_workbook_parser(self):
        for model, names in drive.MODELS.items():
            selected = [{"id": f"id{i}", "name": name} for i, name in enumerate(names)]
            self.assertEqual(drive.workbook_model(f"MODEL_CHOICE = {model!r} # @param []\n"), model)
            self.assertTrue(drive.build_restore_cell("token", selected, model))
            self.assertTrue(drive.build_restore_cell("token", selected[:-1], model))
        with self.assertRaises(ValueError):
            drive.workbook_model("MODEL_CHOICE = __import__('os') # @param []")
        with self.assertRaises(ValueError):
            drive.workbook_model("MODEL_CHOICE = 'MOSS SFT INT8' # @param []\nMODEL_CHOICE = 'MOSS Base INT8' # @param []")

    def test_workbook_profiles_match_all_cache_requirements(self):
        notebook = json.loads((path.parents[1] / "Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb").read_text(encoding="utf-8"))
        cell = "".join(notebook["cells"][6]["source"])
        tree = ast.parse(cell)
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "make_profile"]
        ns = {"ANIMA_REPO": "circlestone-labs/Anima", "MOSS_REPO": "Comfy-Org/MOSS-Image"}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "<profile>", "exec"), ns)
        for model, required in drive.MODELS.items():
            with self.subTest(model=model):
                profile = ns["make_profile"](model)
                self.assertEqual((profile["checkpoint"], profile["encoder"], profile["vae"]), required)
                self.assertTrue(set(required).issubset(drive.FILES))

    def test_custom_model_overrides_builtin_checkpoint_for_each_family(self):
        import os
        notebook = json.loads((path.parents[1] / "Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb").read_text(encoding="utf-8"))
        tree = ast.parse("".join(notebook["cells"][6]["source"]))
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "make_profile")
        ns = {"ANIMA_REPO": "circlestone-labs/Anima", "MOSS_REPO": "Comfy-Org/MOSS-Image", "os": os}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), "<profile>", "exec"), ns)
        for family, encoder in (("anima", "qwen_3_06b_base.safetensors"), ("moss", "qwen3.5_9b_w4a8_gptq.safetensors")):
            with mock.patch.dict(os.environ, {"RGM_CIVITAI_FAMILY": family, "RGM_CIVITAI_CHECKPOINT": "civitai-45-67.safetensors"}):
                profile = ns["make_profile"]("Custom Civitai")
                self.assertEqual(profile["checkpoint"], "civitai-45-67.safetensors")
                self.assertEqual(profile["encoder"], encoder)
        with mock.patch.dict(os.environ, {"RGM_CIVITAI_FAMILY": "anima", "RGM_CIVITAI_CHECKPOINT": "../bad.safetensors"}):
            with self.assertRaises(ValueError): ns["make_profile"]("Custom Civitai")

    def test_community_checkpoint_uses_its_own_repository(self):
        notebook = json.loads((path.parents[1] / "Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb").read_text(encoding="utf-8"))
        tree = ast.parse("".join(notebook["cells"][6]["source"]))
        loop = next(node for node in tree.body if isinstance(node, ast.For) and isinstance(node.target, ast.Tuple)
                    and [item.id for item in node.target.elts] == ["category", "key"])
        calls = []
        profile = {"repo": "circlestone-labs/Anima", "root": "split_files/", "checkpoint": "Anima-2.9B-preview-v1.safetensors", "encoder": "qwen_3_06b_base.safetensors", "vae": "qwen_image_vae.safetensors"}
        exec(compile(ast.Module(body=[loop], type_ignores=[]), "<loop>", "exec"), {"p": profile, "MODEL_CHOICE": "Anima 2.9B Preview BF16", "acquire_weight": lambda *args: calls.append(args)})
        self.assertEqual(calls[0], ("Gazingstars123/Anima-2.9B", profile["checkpoint"], "diffusion_models"))
        self.assertEqual(calls[1], ("circlestone-labs/Anima", "split_files/text_encoders/qwen_3_06b_base.safetensors", "text_encoders"))

    def test_restores_only_verified_files(self):
        by_id = {f["id"]: f["name"] for f in files}
        def get(url, **kwargs): return Response(by_id[url.rsplit("/", 1)[-1]])
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=get):
            root = Path(directory)
            exec(drive.build_restore_cell("token", files), {"MODELS": root})
            for file in files:
                self.assertEqual((root / drive.FILES[file["name"]] / file["name"]).read_bytes(), b"abc")

    def test_custom_checkpoint_restores_to_identity_path_and_verifies_sha(self):
        selected = [{"id": "id1", "name": "qwen_3_06b_base.safetensors"}, {"id": "id2", "name": "qwen_image_vae.safetensors"}, {"id": "id3", "name": "example model.safetensors"}]
        custom = {"version": {"id": 45, "family": "anima", "files": [{"id": 67, "name": "example model.safetensors", "sha256": hashlib.sha256(b"abc").hexdigest()}]}, "fileId": 67}
        by_id = {f["id"]: f["name"] for f in selected}
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=lambda url, **kw: Response(by_id[url.rsplit("/", 1)[-1]])):
            root = Path(directory)
            exec(drive.build_restore_cell("token", selected, "Custom Civitai", "anima", custom), {"MODELS": root})
            self.assertEqual((root / "diffusion_models" / "civitai-45-67.safetensors").read_bytes(), b"abc")
        custom["version"]["files"][0]["sha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=lambda url, **kw: Response(by_id[url.rsplit("/", 1)[-1]])):
            with self.assertRaises(RuntimeError): exec(drive.build_restore_cell("token", selected, "Custom Civitai", "anima", custom), {"MODELS": Path(directory)})

    def test_corrupt_download_never_becomes_a_model(self):
        class Corrupt(Response):
            def iter_content(self, _size): yield b"bad"
        by_id = {f["id"]: f["name"] for f in files}
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=lambda url, **kw: Corrupt(by_id[url.rsplit("/", 1)[-1]])):
            root = Path(directory)
            with self.assertRaises(RuntimeError): exec(drive.build_restore_cell("token", files), {"MODELS": root})
            dest = root / drive.FILES[files[0]["name"]] / files[0]["name"]
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix(dest.suffix + ".part").exists())


if __name__ == "__main__": unittest.main()
