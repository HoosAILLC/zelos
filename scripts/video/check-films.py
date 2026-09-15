#!/usr/bin/env python3
"""Verify the committed product films decode and match their public metadata."""

import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "website/video"


def main():
    ffprobe, ffmpeg = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise SystemExit("Install ffmpeg (including ffprobe) to check the films.")
    films = json.loads((OUTPUT / "films.json").read_text())["films"]
    assert len(films) == 2, "Both product films must be present"
    for film in films:
        path = OUTPUT / f"{film['slug']}.mp4"
        content = path.read_bytes()
        assert len(content) == film["bytes"], f"Stale byte count: {path.name}"
        assert hashlib.sha256(content).hexdigest() == film["sha256"], f"Stale hash: {path.name}"
        probe = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
        assert (video["width"], video["height"]) == (1280, 720)
        assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
        assert video["r_frame_rate"] == "24/1"
        assert audio["codec_name"] == "aac" and audio["channels"] == 2
        assert abs(float(probe["format"]["duration"]) - film["durationSeconds"]) < 0.1
        # Parse top-level ISO-BMFF atoms; a filename containing “moov” is not proof.
        atoms, position = [], 0
        while position + 8 <= len(content):
            size, kind = struct.unpack_from(">I4s", content, position)
            if size == 1:
                size = struct.unpack_from(">Q", content, position + 8)[0]
            elif size == 0:
                size = len(content) - position
            assert size >= 8, "Invalid MP4 atom size"
            atoms.append(kind)
            position += size
        assert atoms.index(b"moov") < atoms.index(b"mdat"), "Movie is not optimized for progressive playback"
        result = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True, text=True)
        assert result.returncode == 0 and not result.stderr.strip(), result.stderr
        assert (OUTPUT / f"{film['slug']}.jpg").stat().st_size > 10000
        assert (OUTPUT / f"{film['slug']}.vtt").read_text().startswith("WEBVTT\n")
        transcript = (OUTPUT / f"{film['slug']}.txt").read_text()
        assert "Fictional demo data" in transcript and "Edited walkthrough" in transcript
        print(f"PASS {film['title']}: full decode, H.264/AAC, 720p, 24 fps, {film['durationSeconds']}s, fast start, poster, text track, transcript, SHA-256")


if __name__ == "__main__":
    main()
