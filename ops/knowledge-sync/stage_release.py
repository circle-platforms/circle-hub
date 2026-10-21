#!/usr/bin/env python3
"""Stage an OpenKM release-document export for the existing converters.

The converters (docx2md.py, pdf2md.py) only pick up .docx and .pdf. Release notes are mostly legacy .doc plus a PDF twin.
This step keeps the export layout (<cycle>/<relative path>) and produces two staging trees:
  <docx_stage>  .docx files linked as they are, legacy .doc files converted with the local LibreOffice
  <pdf_stage>   PDF files that have no Word twin (the Word twin is converted locally instead of the cloud converter)
Conversions are skipped when the staged file is newer than its source. Nothing in the export tree is modified.

Usage: stage_release.py <export_dir> <docx_stage> <pdf_stage>
"""
import os
import shutil
import subprocess
import sys
import tempfile

WORD = (".docx", ".doc")


def link(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.lexists(dst):
        os.remove(dst)
    try:
        os.symlink(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def convert_doc(src, dst):
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return True
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="doc2docx_") as tmp:
        try:
            r = subprocess.run(
                ["soffice", "--headless", "--convert-to", "docx", "--outdir", tmp, src],
                capture_output=True, text=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            print(f"[timeout] {src}")
            return False
        out = os.path.join(tmp, os.path.splitext(os.path.basename(src))[0] + ".docx")
        if r.returncode != 0 or not os.path.exists(out):
            print(f"[fail] {src}: {r.stderr.strip()[:120]}")
            return False
        shutil.move(out, dst)
    return True


def main(export_dir, docx_stage, pdf_stage):
    export_dir = os.path.abspath(export_dir)
    counts = {"docx_linked": 0, "doc_converted": 0, "doc_failed": 0, "pdf_alone": 0, "pdf_skipped_twin": 0}
    for root, _dirs, files in os.walk(export_dir):
        if os.path.abspath(root) == export_dir:
            continue  # state files at the top level (snapshot.tsv)
        by_stem = {}
        for f in files:
            if f.startswith("~$") or f == "manifest.json":
                continue
            stem, ext = os.path.splitext(f)
            by_stem.setdefault(stem.lower(), {})[ext.lower()] = f
        for stem, exts in sorted(by_stem.items()):
            rel_dir = os.path.relpath(root, export_dir)
            if ".docx" in exts:
                f = exts[".docx"]
                link(os.path.join(root, f), os.path.join(docx_stage, rel_dir, f))
                counts["docx_linked"] += 1
            elif ".doc" in exts:
                f = exts[".doc"]
                dst = os.path.join(docx_stage, rel_dir, os.path.splitext(f)[0] + ".docx")
                if convert_doc(os.path.join(root, f), dst):
                    counts["doc_converted"] += 1
                else:
                    counts["doc_failed"] += 1
            if ".pdf" in exts:
                f = exts[".pdf"]
                if ".docx" in exts or ".doc" in exts:
                    counts["pdf_skipped_twin"] += 1
                else:
                    link(os.path.join(root, f), os.path.join(pdf_stage, rel_dir, f))
                    counts["pdf_alone"] += 1
    print("stage: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    return 0 if counts["doc_failed"] == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(*sys.argv[1:]))
