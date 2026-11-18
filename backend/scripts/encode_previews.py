"""
Re-encode the preview clips for the web. Local files only: reads a folder, writes a new folder.

The clips in the preview bucket are full-quality recordings (Ego-centric: HEVC 3840x1200 at ~17 Mbit/s,
~75 MB each; head + wrist: H.264 2560x1600 at ~16 Mbit/s). A visitor needs ~17 Mbit/s just to play one
without stalling, and Firefox (and PCs without an HEVC decoder) can't play HEVC at all. This makes:

  H.264 (plays in every browser), at most 1920x600 for Ego-centric (both eyes, 960x600 each) and
  1280x800 for head + wrist, quality-based (CRF 23) but capped at 2.5 Mbit/s, a keyframe every 2 s
  (quick seeks and starts), no audio track (the site always mutes; recordings can carry voices),
  and the index at the front of the file (+faststart) so playback starts with the first bytes.

Same folder layout and file names in the output, so the output folder can be uploaded as is.

  python scripts/encode_previews.py <downloaded-bucket-folder> <output-folder>    [--jobs 2]

Uploading is up to you (it writes to a bucket). Back the originals up first, inside the same bucket
(a backup-*/ prefix is never listed as a clip), then upload the output over them under the same names:
  rclone copy r2:<bucket> r2:<bucket>/backup-<date> --exclude "backup-*/**"
  rclone copy <output-folder> r2:<bucket>
Switching back is the first command reversed.
"""
import argparse
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

VF = "scale=w='min(iw,1920)':h='min(ih,800)':force_original_aspect_ratio=decrease:force_divisible_by=2"
ARGS = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-crf", "23", "-maxrate", "2500k", "-bufsize", "5000k",
        "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
        "-an", "-movflags", "+faststart"]


def encode(src: Path, dst: Path) -> str:
    if dst.exists() and dst.stat().st_size > 0:
        return f"skip  {dst}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    part = dst.with_suffix(".part.mp4")
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", VF, *ARGS, str(part)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        part.unlink(missing_ok=True)
        return f"FAIL  {src}: {r.stderr.strip()[-300:]}"
    part.replace(dst)
    return f"done  {dst}  {src.stat().st_size / 1e6:.1f} MB -> {dst.stat().st_size / 1e6:.1f} MB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--jobs", type=int, default=2)
    a = ap.parse_args()
    files = sorted(p for p in a.src.rglob("*.mp4") if not p.name.endswith(".part.mp4"))
    if not files:
        sys.exit(f"no .mp4 files under {a.src}")
    print(f"{len(files)} clips")
    with ThreadPoolExecutor(a.jobs) as ex:
        for line in ex.map(lambda p: encode(p, a.out / p.relative_to(a.src)), files):
            print(line, flush=True)


if __name__ == "__main__":
    main()
