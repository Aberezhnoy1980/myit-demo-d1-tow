"""Package D1's explicit public allowlist; no network or third-party dependencies."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
files = ["index.html", "styles.css", "config.js", "app.js", "assets/tow-640.webp",
         "assets/tow-1200.webp", "assets/tow-1200.jpg", "assets/LICENSE.md"]
public = root / "dist" / "public"
existing = {str(p.relative_to(public)) for p in public.rglob("*") if p.is_file()}
unexpected = existing - set(files)
if unexpected:
    raise SystemExit(f"Unexpected public files; inspect before packaging: {sorted(unexpected)}")
for name in files:
    src, dst = root / name, public / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
manifest = [{"path": name, "bytes": (public / name).stat().st_size,
             "sha256": hashlib.sha256((public / name).read_bytes()).hexdigest()} for name in files]
release = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
archive = root / "dist" / "d1-tow.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for name in files:
        bundle.write(public / name, name)
(root / "dist" / "manifest.json").write_text(
    json.dumps({"release": release, "files": manifest}, ensure_ascii=False, indent=2) + "\n")
with zipfile.ZipFile(archive) as bundle:
    assert set(bundle.namelist()) == set(files)
    assert bundle.testzip() is None
print(f"release={release}; {len(files)} public files; zip={archive.stat().st_size} bytes")
print(f"Public root: {public}")
