#!/usr/bin/env python3
"""Generate UI locales from en.js using Pi; --prune only removes obsolete keys."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOCALES = ROOT / "web/src/shared/locales"
LANGUAGES = {"de": "German", "es": "Spanish", "fil": "Filipino", "fr": "French", "id": "Indonesian", "ja": "Japanese", "km": "Khmer", "lo": "Lao", "ms": "Malay", "my": "Burmese", "th": "Thai", "vi": "Vietnamese", "zh": "Simplified Chinese"}


def read_locale(code):
    url = (LOCALES / f"{code}.js").as_uri()
    output = subprocess.check_output(["node", "--input-type=module", "-e", f"import data from {json.dumps(url)}; console.log(JSON.stringify(data));"], encoding="utf-8")
    return json.loads(output)


def pi_command():
    binary = shutil.which("pi")
    if not binary:
        raise RuntimeError("pi is not installed")
    if os.name == "nt" and not binary.lower().endswith(".exe"):
        entry = Path(binary).parent / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
        return [shutil.which("node"), str(entry)]
    return [binary]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("languages", nargs="*", choices=list(LANGUAGES))
    parser.add_argument("--prune", action="store_true")
    args = parser.parse_args()
    english = read_locale("en")
    for code in args.languages or LANGUAGES:
        if args.prune:
            strings = {key: value for key, value in read_locale(code).items() if key in english}
        else:
            prompt = "Translate this mobile Pi remote-control UI into " + LANGUAGES[code] + ". Keep labels concise. Preserve every JSON key and any {placeholder}. Return only the JSON object with string values.\n" + json.dumps(english, ensure_ascii=False)
            result = subprocess.run(pi_command() + ["--print", "--thinking", "off", "--no-session", "--no-tools", "--no-mcp", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", prompt], capture_output=True, encoding="utf-8", timeout=60, check=True)
            raw = result.stdout.strip()
            strings = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
            if set(strings) != set(english) or not all(isinstance(value, str) and value for value in strings.values()):
                raise ValueError(f"{code}: incomplete translation")
        (LOCALES / f"{code}.js").write_text("// Generated from en.js by scripts/build_locales.py.\nexport default " + json.dumps(strings, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
        print(f"{code}: {len(strings)} keys")


if __name__ == "__main__":
    main()
