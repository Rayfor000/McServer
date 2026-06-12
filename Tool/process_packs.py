import argparse
import hashlib
import json
import os
import re
import shutil
from collections import OrderedDict
from pathlib import Path
from typing import Any

# Optional Pillow dependency for image compression
try:
    from PIL import Image

    HAS_PILLOW = True
except ImportError:
    Image = None  # type: ignore[assignment]
    HAS_PILLOW = False

# Constants and Configuration defaults
TEXT_EXTS = {".json", ".mcmeta", ".mcfunction"}
BINARY_EXTS = {".png", ".ogg", ".ttf", ".otf", ".nbt", ".zip"}

# JSON keys that MUST NOT be processed for translation (System values / MC Registry IDs)
RESERVED_JSON_KEYS = {
    "id",
    "type",
    "trigger",
    "item",
    "tag",
    "to_apply",
    "condition",
    "enchanted",
    "affected",
    "slot",
    "slots",
    "mode",
    "action",
    "after_action",
    "dimension",
    "criteria",
    "parent",
    "requirements",
    "predicate",
    "translate",
    "fallback",
}


# Helper to check if a string is a standard technical ID or reserved string
def is_technical_id(s: str) -> bool:
    s_strip = s.strip()
    if not s_strip:
        return True
    # Ignore scoreboard dummy players, selectors, system flags, and constants
    if s_strip.startswith(("$", "#", "%", "@")):
        return True
    # Skip long Base64 skin texture encoded strings (starts with ey... and consists of valid base64 chars)
    if len(s_strip) > 50 and s_strip.startswith("ey") and re.match(r"^[a-zA-Z0-9+/=]+$", s_strip):  # noqa: PLR2004
        return True
    # Common UI label words are human-readable texts, not technical IDs
    common_ui_words = {"exit", "confirm", "cancel", "save", "close", "back", "next", "standard", "high", "extreme", "minimal", "low", "fast", "slow", "sloth", "hypersonic", "progression", "frequency", "speed"}
    if s_strip.lower() in common_ui_words:
        return False
    # If it is an resource location with a namespace (e.g. mine:wither_sword)
    if ":" in s_strip:
        parts = s_strip.split(":", 1)
        if re.match(r"^[a-zA-Z0-9_.-]+$", parts[0]) and re.match(r"^[a-zA-Z0-9_./-]+$", parts[1]):
            return True
    # If it matches alphanumeric technical naming styles (no spaces)
    return bool(re.match(r"^[a-zA-Z0-9_./-]+$", s_strip))


class DatapackProcessor:
    def __init__(self, source_dir: Path, output_dir: Path, *, compress_images: bool = True) -> None:
        self.source_dir = source_dir
        self.output_dir = output_dir
        self.compress_images = compress_images
        self.translations: dict[str, dict[str, Any]] = {}
        self.current_file_rel = ""
        self.namespace = self._find_default_namespace()
        self.existing_langs: dict[str, dict[str, str]] = {
            "en_us": {},
            "zh_tw": {},  # Ensure zh_tw is always populated for template synchronization
        }
        self.english_to_local: dict[str, dict[str, str]] = {"zh_tw": {}}

    def _find_default_namespace(self) -> str:
        # Dynamically scan the pack to find the main custom namespace
        for dir_name in ("data", "assets"):
            dir_path = self.source_dir / dir_name
            if dir_path.exists():
                for sub in dir_path.iterdir():
                    if sub.is_dir() and sub.name not in ("minecraft", "realms"):
                        return sub.name
        clean_name = re.sub(r"[^a-zA-Z0-9_]", "_", self.source_dir.name).lower().strip("_")
        return clean_name or "custom_pack"

    def resolve_namespace(self, rel_path: Path) -> str:
        parts = rel_path.parts
        if len(parts) >= 2 and parts[0] in ("data", "assets"):  # noqa: PLR2004
            return parts[1]
        if len(parts) >= 3 and parts[1] in ("data", "assets"):  # noqa: PLR2004
            return parts[2]
        return self.namespace

    def add_translation(self, key: str, value: str, *, old_key: str | None = None) -> None:  # noqa: C901
        ns = self._find_default_namespace()
        if ns not in self.translations:
            self.translations[ns] = {}

        # Restore any unicode escape placeholders in translation value before saving
        value_restored = re.sub(r"__UNICODE_HEX_([0-9a-fA-F]{4})__", lambda m: chr(int(m.group(1), 16)), value)

        # 1. Update en_us first
        if "en_us" not in self.translations[ns]:
            self.translations[ns]["en_us"] = OrderedDict()
        if key not in self.translations[ns]["en_us"]:
            self.translations[ns]["en_us"][key] = value_restored

        # 2. Update and align all other known languages (e.g. zh_tw)
        for lang_code in self.existing_langs:
            if lang_code == "en_us":
                continue
            if lang_code not in self.translations[ns]:
                self.translations[ns][lang_code] = OrderedDict()
            if key not in self.translations[ns][lang_code]:
                # Prepare cleaned keys for lookup
                val_cleaned = value_restored.strip().lower()
                val_alphanumeric = re.sub(r"[^a-zA-Z0-9]", "", val_cleaned)

                # Check 1: Try English value direct match first (Solves English source change / UID shift!)
                if lang_code in self.english_to_local and val_cleaned in self.english_to_local[lang_code]:
                    self.translations[ns][lang_code][key] = self.english_to_local[lang_code][val_cleaned]
                # Check 2: Try fuzzy alphanumeric match
                elif lang_code in self.english_to_local and f"fuzzy_{val_alphanumeric}" in self.english_to_local[lang_code]:
                    self.translations[ns][lang_code][key] = self.english_to_local[lang_code][f"fuzzy_{val_alphanumeric}"]
                # Check 3: If this exact key is already present in the loaded dictionary (direct key match)
                elif key in self.existing_langs[lang_code]:
                    self.translations[ns][lang_code][key] = self.existing_langs[lang_code][key]
                # Check 4: If we mapped from an old key and have an existing localized value, preserve it
                elif old_key and old_key in self.existing_langs[lang_code]:
                    self.translations[ns][lang_code][key] = self.existing_langs[lang_code][old_key]
                else:
                    self.translations[ns][lang_code][key] = value_restored

    def get_hash_key(self, text: str) -> str:
        # Restore any unicode escape placeholders in key generation to match real text hash
        text_restored = re.sub(r"__UNICODE_HEX_([0-9a-fA-F]{4})__", lambda m: chr(int(m.group(1), 16)), text)
        h_bytes = hashlib.sha256(text_restored.encode("utf-8")).digest()
        val_64 = int.from_bytes(h_bytes[:8], byteorder="big")
        base62_chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if val_64 == 0:
            b62 = base62_chars[0]
        else:
            arr = []
            num = val_64
            while num:
                num, rem = divmod(num, 62)
                arr.append(base62_chars[rem])
            b62 = "".join(reversed(arr))
        b62 = b62.zfill(11)
        return f"{self.namespace}.{b62}"

    def process_json_recursive(self, obj: Any, parent_key: str = "", line_no: int = 1, *, in_book: bool = False) -> tuple[Any, bool]:  # noqa: ANN401, C901, PLR0912
        modified = False
        if isinstance(obj, dict):
            # 1. Check for existing translate & fallback structure
            if "translate" in obj and "fallback" in obj and isinstance(obj["translate"], str) and isinstance(obj["fallback"], str):
                fallback_val = obj["fallback"]
                old_key = obj["translate"]
                t_key = self.get_hash_key(fallback_val)
                obj["translate"] = t_key
                self.add_translation(t_key, fallback_val, old_key=old_key)
                modified = True

            # 2. Check for direct text components
            elif "text" in obj and isinstance(obj["text"], str):
                if in_book and parent_key == "title":
                    # Skip translating book title text components to remain raw string
                    pass
                else:
                    text_val = obj["text"]
                    if not is_technical_id(text_val) or text_val.strip():
                        t_key = self.get_hash_key(text_val)
                        self.add_translation(t_key, text_val)
                        obj["translate"] = t_key
                        obj["fallback"] = text_val
                        obj.pop("text")
                        # If type exists and is "text", override it to "translatable" as per spec
                        if "type" in obj and obj["type"] == "text":
                            obj["type"] = "translatable"
                        modified = True

            new_dict = {}
            for k, v in obj.items():
                if k in RESERVED_JSON_KEYS:
                    new_dict[k] = v
                    continue

                # Special safety: written_book_content's title must remain a raw string and not be translated
                if (parent_key.endswith("written_book_content") or in_book) and k == "title":
                    new_dict[k] = v
                    continue

                if isinstance(v, str):
                    # Title and label keys are always display UI texts, exempt from technical ID filter
                    is_title_or_label = k in ("title", "label")
                    should_translate = not v.startswith(("$", "#", "%", "@")) and ":" not in v if is_title_or_label else not is_technical_id(v)

                    if should_translate:
                        t_key = self.get_hash_key(v)
                        self.add_translation(t_key, v)
                        new_dict[k] = {"translate": t_key, "fallback": v}
                        modified = True
                        continue

                next_in_book = in_book or k.endswith("written_book_content")
                processed_val, item_modified = self.process_json_recursive(v, k, line_no, in_book=next_in_book)
                new_dict[k] = processed_val
                if item_modified:
                    modified = True
            return new_dict, modified

        if isinstance(obj, list):
            new_list = []
            for item in obj:
                processed_item, item_modified = self.process_json_recursive(item, parent_key, line_no, in_book=in_book)
                new_list.append(processed_item)
                if item_modified:
                    modified = True
            return new_list, modified

        return obj, modified

    def minify_json(self, content: str) -> str:
        try:
            data = json.loads(content)
            # Only apply recursive i18n translation processing to data pack files.
            # All resource pack files (in assets/) should ONLY be minified (the lang files are skipped and handled at the end).
            is_resource_file = self.current_file_rel.startswith("assets/")
            if not is_resource_file:
                data, _ = self.process_json_recursive(data)
        except json.JSONDecodeError:
            return content
        else:
            return json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    def process_mcmeta(self, content: str) -> str:
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            return content
        else:
            return json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    def _preprocess_nbt_json(self, json_str: str) -> str:  # noqa: C901, PLR0912, PLR0915
        result = []
        i = 0
        n = len(json_str)
        bracket_stack = []
        in_string = False
        escape = False

        while i < n:
            char = json_str[i]

            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                result.append(char)
                i += 1
                continue

            if char == '"':
                in_string = True
                escape = False
                result.append(char)
                i += 1
                continue

            if char == "{":
                bracket_stack.append("{")
                result.append(char)
                i += 1
                continue
            if char == "}":
                if bracket_stack and bracket_stack[-1] == "{":
                    bracket_stack.pop()
                result.append(char)
                i += 1
                continue
            if char == "[":
                bracket_stack.append("[")
                result.append(char)
                i += 1
                continue
            if char == "]":
                if bracket_stack and bracket_stack[-1] == "[":
                    bracket_stack.pop()
                result.append(char)
                i += 1
                continue

            if char == "$" and i + 1 < n and json_str[i + 1] == "(":
                match = re.match(r"^\$\(([a-zA-Z0-9_]+)\)", json_str[i:])
                if match:
                    macro_full = match.group(0)
                    macro_len = len(macro_full)

                    prev_idx = i - 1
                    while prev_idx >= 0 and json_str[prev_idx].isspace():
                        prev_idx -= 1
                    is_after_colon = prev_idx >= 0 and json_str[prev_idx] == ":"

                    next_idx = i + macro_len
                    while next_idx < n and json_str[next_idx].isspace():
                        next_idx += 1
                    is_before_colon = next_idx < n and json_str[next_idx] == ":"

                    in_object = bool(bracket_stack and bracket_stack[-1] == "{")

                    if in_object and not is_after_colon and not is_before_colon:
                        result.append(f"{macro_full}:true")
                    else:
                        result.append(macro_full)

                    i += macro_len
                    continue

            result.append(char)
            i += 1

        return "".join(result)

    def process_mcfunction(self, content: str) -> str:
        # Join logical lines split by backslash '\' (Minecraft line continuation)
        physical_lines = content.splitlines()
        logical_lines = []
        current_line = []
        for pline in physical_lines:
            if pline.endswith("\\"):
                current_line.append(pline.rstrip("\\\r\n").rstrip())
            else:
                current_line.append(pline)
                logical_lines.append("".join(current_line))
                current_line = []
        if current_line:
            logical_lines.append("".join(current_line))

        optimized_lines = []
        for line_idx, line in enumerate(logical_lines, 1):
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#"):
                continue

            json_match = re.search(r"(\{.*\})\s*$", trimmed)
            if json_match:
                json_str = json_match.group(1)

                # 1. Pre-process unquoted lone macro variables in object NBT context safely using syntax state tracking
                json_str_pre1 = self._preprocess_nbt_json(json_str)

                # 2. Pre-process NBT special arrays (e.g., [I; -1974... ] -> ["__NBT_ARRAY_I__", -1974... ]) to ensure valid JSON loads
                nbt_array_pattern = re.compile(r"\[([IBlL]);")
                json_str_pre2 = nbt_array_pattern.sub(r'["__NBT_ARRAY_\1__",', json_str_pre1)

                # 3. Temporarily replace \uXXXX Unicode escapes to prevent decode loss
                unicode_pattern = re.compile(r"\\u([0-9a-fA-F]{4})")
                json_str_no_unicode = unicode_pattern.sub(r"__UNICODE_HEX_\1__", json_str_pre2)

                # 4. Temporarily replace $(var) macro variables with valid JSON placeholders to ensure loads works
                macro_pattern = re.compile(r"\$\(([a-zA-Z0-9_]+)\)")
                json_str_placeholder = macro_pattern.sub(r'"$__MACRO_VAR_\1__"', json_str_no_unicode)

                try:
                    obj = json.loads(json_str_placeholder)
                    processed_obj, _ = self.process_json_recursive(obj, line_no=line_idx)
                    minified_json_str = json.dumps(processed_obj, separators=(",", ":"), ensure_ascii=False)
                    # Revert placeholders back to macro variables
                    minified_json_str = re.sub(r'"\$__MACRO_VAR_([a-zA-Z0-9_]+)__"', r"$(" + r"\1" + r")", minified_json_str)
                    # Revert NBT special arrays back to original format
                    minified_json_str = re.sub(r'\[\s*"__NBT_ARRAY_([IBlL])__"\s*,', r"[\1;", minified_json_str)
                    # Revert NBT-safe lone macro variables back to unquoted lone formats
                    minified_json_str = re.sub(r"\$\(([a-zA-Z0-9_]+)\):true", r"$(" + r"\1" + r")", minified_json_str)
                    # Revert unicode placeholders back to \uXXXX format
                    minified_json_str = re.sub(r"__UNICODE_HEX_([0-9a-fA-F]{4})__", r"\\u" + r"\1", minified_json_str)
                    trimmed = trimmed[: json_match.start()] + minified_json_str
                except json.JSONDecodeError:
                    try:
                        # Attempt SNBT/Loose JSON conversion on placeholder string
                        standard_json_str = re.sub(r'(?<!["\'])\b([a-zA-Z0-9_.-]+)\b(?=\s*:)', r'"\1"', json_str_placeholder)
                        standard_json_str = re.sub(r"\b([0-9.]+)[bBsSfFdD]\b", r"\1", standard_json_str)

                        obj = json.loads(standard_json_str)
                        processed_obj, _ = self.process_json_recursive(obj, line_no=line_idx)
                        minified_json_str = json.dumps(processed_obj, separators=(",", ":"), ensure_ascii=False)
                        minified_json_str = re.sub(r'"\$__MACRO_VAR_([a-zA-Z0-9_]+)__"', r"$(" + r"\1" + r")", minified_json_str)
                        minified_json_str = re.sub(r'\[\s*"__NBT_ARRAY_([IBlL])__"\s*,', r"[\1;", minified_json_str)
                        minified_json_str = re.sub(r"\$\(([a-zA-Z0-9_]+)\):true", r"$(" + r"\1" + r")", minified_json_str)
                        minified_json_str = re.sub(r"__UNICODE_HEX_([0-9a-fA-F]{4})__", r"\\u" + r"\1", minified_json_str)
                        trimmed = trimmed[: json_match.start()] + minified_json_str
                    except Exception:  # noqa: BLE001, S110
                        pass

            optimized_lines.append(trimmed)
        return "\n".join(optimized_lines)

    def compress_image_file(self, src_path: Path, target_path: Path) -> None:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if self.compress_images and HAS_PILLOW:
            try:
                with Image.open(src_path) as img:  # type: ignore[union-attr]
                    img.save(target_path, "PNG", optimize=True)
            except Exception:  # noqa: BLE001, S110
                pass
            else:
                return
        shutil.copy2(src_path, target_path)

    def run(self) -> None:  # noqa: C901, PLR0912, PLR0915
        # 0. Load any existing localization files from BOTH source and output dirs before wiping
        # We load output_dir first and source_dir second so that the developer's original source translations
        # always take precedence and override any old residual translation files in the output directory.
        for base_dir in (self.output_dir, self.source_dir):
            source_assets = base_dir / "assets"
            if source_assets.exists():
                for ns_dir in source_assets.iterdir():
                    if ns_dir.is_dir():
                        lang_dir = ns_dir / "lang"
                        if lang_dir.exists():
                            for lang_file in lang_dir.glob("*.json"):
                                lang_code = lang_file.stem
                                try:
                                    with lang_file.open("r", encoding="utf-8") as f:
                                        data = json.load(f)
                                        if isinstance(data, dict):
                                            if lang_code not in self.existing_langs:
                                                self.existing_langs[lang_code] = {}
                                            for k, v in data.items():
                                                if isinstance(v, str):
                                                    self.existing_langs[lang_code][k] = v
                                except Exception:  # noqa: BLE001, S110
                                    pass

        # Build Global English-to-Local value mappings based on same old keys (handles UID shift / source change!)
        if "en_us" in self.existing_langs:
            for key, eng_val in self.existing_langs["en_us"].items():
                eng_cleaned = eng_val.strip().lower()
                for lang_code, lang_dict in self.existing_langs.items():
                    if lang_code == "en_us":
                        continue
                    if key in lang_dict:
                        if lang_code not in self.english_to_local:
                            self.english_to_local[lang_code] = {}
                        self.english_to_local[lang_code][eng_cleaned] = lang_dict[key]
                        # Also support matching by removing common symbols or trailing spaces
                        eng_alphanumeric = re.sub(r"[^a-zA-Z0-9]", "", eng_cleaned)
                        if eng_alphanumeric:
                            self.english_to_local[lang_code][f"fuzzy_{eng_alphanumeric}"] = lang_dict[key]

        # Now we can safely wipe and recreate output directory
        if self.output_dir.exists():
            shutil.rmtree(self.output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        for root, _, files in os.walk(self.source_dir):
            for file in files:
                src_file_path = Path(root) / file
                rel_path = src_file_path.relative_to(self.source_dir)
                self.current_file_rel = rel_path.as_posix()

                # Check if this is a language JSON file in assets (e.g. assets/<ns>/lang/zh_tw.json)
                # We MUST skip these files during the file walking and copying phase,
                # because they are loaded into memory at the beginning, aligned,
                # and written out correctly at the very end of the run() function.
                if self.current_file_rel.startswith("assets/") and "lang/" in self.current_file_rel and self.current_file_rel.endswith(".json"):
                    continue

                self.namespace = self.resolve_namespace(rel_path)

                target_file_path = self.output_dir / rel_path
                target_file_path.parent.mkdir(parents=True, exist_ok=True)

                ext = src_file_path.suffix.lower()

                if ext == ".png":
                    self.compress_image_file(src_file_path, target_file_path)
                elif ext in BINARY_EXTS:
                    shutil.copy2(src_file_path, target_file_path)
                elif ext in TEXT_EXTS or file == "pack.mcmeta":
                    try:
                        with src_file_path.open("r", encoding="utf-8", errors="ignore") as f:
                            content = f.read()

                        if file == "pack.mcmeta":
                            result = self.process_mcmeta(content)
                        elif ext == ".json":
                            result = self.minify_json(content)
                        elif ext == ".mcfunction":
                            result = self.process_mcfunction(content)
                        else:
                            result = content.strip()

                        with target_file_path.open("w", encoding="utf-8", newline="\n") as f:
                            f.write(result)
                    except Exception:  # noqa: BLE001
                        shutil.copy2(src_file_path, target_file_path)
                else:
                    shutil.copy2(src_file_path, target_file_path)

        if self.translations:
            for ns, lang_dict in self.translations.items():
                for lang_code, trans_dict in lang_dict.items():
                    lang_dir = self.output_dir / "assets" / ns / "lang"
                    lang_dir.mkdir(parents=True, exist_ok=True)
                    lang_file_path = lang_dir / f"{lang_code}.json"

                    with lang_file_path.open("w", encoding="utf-8") as f:
                        json.dump(trans_dict, f, ensure_ascii=False, indent=4)


def main() -> None:
    parser = argparse.ArgumentParser(description="Minecraft Datapack and Resource Pack Optimizer & i18n Parser")
    parser.add_argument("-s", "--source", required=True, help="Path to the source pack directory")
    parser.add_argument("-o", "--output", required=True, help="Path to the processed output directory")
    parser.add_argument("--no-img-compress", action="store_true", help="Disable lossless image optimization")

    args = parser.parse_args()

    src_path = Path(args.source)
    out_path = Path(args.output)

    if not src_path.exists():
        print(f"Error: Source directory {src_path} does not exist.")  # noqa: T201
        return

    processor = DatapackProcessor(source_dir=src_path, output_dir=out_path, compress_images=not args.no_img_compress)
    processor.run()
    print("Optimization and processing successfully finished!")  # noqa: T201


if __name__ == "__main__":
    main()
