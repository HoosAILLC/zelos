#!/usr/bin/env python3
"""Render Zelos's original, caption-led product films from reviewed UI captures.

No browser automation takes place here. Every input is a screenshot captured
through the browser's supported screenshot API using fictional demo records.
"""

from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import wave

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parents[2]
WIDTH, HEIGHT, FPS = 1280, 720, 24
PAPER = (244, 243, 239)
INK = (25, 25, 25)
MUTED = (105, 107, 99)
GREEN = (97, 111, 88)
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
DISCLOSURE = f"{VERSION} preview  ·  Fictional demo data  ·  Edited walkthrough"
SCREEN_LABELS = {
    "morning-now.png": "Now overview with meetings, messages, and commitments",
    "morning-ask.png": "Ask meeting brief with source references",
    "dinner-health.png": "Health goals and food preferences",
    "dinner-discovery.png": "Groceries Discovery recipe cards",
    "dinner-meal-plan.png": "Health meal-plan review",
    "dinner-groceries.png": "Groceries list",
}


FILMS = [
    {
        "slug": "a-clearer-day",
        "title": "A clearer day",
        "description": "A morning overview and a meeting brief bring the useful details together.",
        "duration": 27,
        "poster_time": 7.0,
        "scenes": [
            {"start": 0, "end": 3.7, "kind": "title", "eyebrow": "ZELOS  /  A CLEARER DAY", "lines": ["Your day.", "Already in focus."], "accent": 1, "caption": "Your day. Already in focus."},
            {"start": 3.7, "end": 10.6, "kind": "screen", "image": "morning-now.png", "eyebrow": "01  /  SEE THE DAY", "lines": ["Know what needs you."], "caption": "Bring your meetings, messages, and commitments into one view.", "crop_from": [0.235, 0.205, 0.965, 0.682], "crop_to": [0.265, 0.315, 0.955, 0.765]},
            {"start": 10.6, "end": 19.7, "kind": "screen", "image": "morning-ask.png", "eyebrow": "02  /  ARRIVE PREPARED", "lines": ["Get straight to the context."], "caption": "Ask for a meeting brief. Get useful details with their sources.", "crop_from": [0.225, 0.29, 0.955, 0.767], "crop_to": [0.265, 0.345, 0.94, 0.785]},
            {"start": 19.7, "end": 23.4, "kind": "title", "eyebrow": "A LITTLE LESS CATCHING UP", "lines": ["More time", "to show up."], "accent": 1, "caption": "A little less catching up. More time to show up."},
            {"start": 23.4, "end": 27, "kind": "end", "eyebrow": "ZELOS", "lines": ["Make room for life."], "caption": "Explore the current preview at zelos-app.netlify.app."},
        ],
    },
    {
        "slug": "make-room-for-dinner",
        "title": "Make room for dinner",
        "description": "Turn health preferences into a meal plan you review and a useful grocery list.",
        "duration": 30,
        "poster_time": 11.0,
        "scenes": [
            {"start": 0, "end": 3.4, "kind": "title", "eyebrow": "ZELOS  /  MAKE ROOM FOR DINNER", "lines": ["Dinner starts", "with a little less work."], "accent": 1, "caption": "Dinner starts with a little less work."},
            {"start": 3.4, "end": 8.8, "kind": "screen", "image": "dinner-health.png", "eyebrow": "01  /  START WITH YOUR NEEDS", "lines": ["Your preferences come first."], "caption": "Bring your health goals, food preferences, and household needs together.", "crop_from": [0.185, 0.43, 0.995, 0.959], "crop_to": [0.19, 0.46, 0.995, 0.985]},
            {"start": 8.8, "end": 13.6, "kind": "screen", "image": "dinner-discovery.png", "eyebrow": "02  /  FIND SOMETHING GOOD", "lines": ["Make the week more delicious."], "caption": "Explore meal ideas. Choose what fits your week.", "crop_from": [0.208, 0.172, 0.98, 0.676], "crop_to": [0.22, 0.18, 0.97, 0.67]},
            {"start": 13.6, "end": 20.2, "kind": "screen", "image": "dinner-meal-plan.png", "eyebrow": "03  /  REVIEW THE PLAN", "lines": ["A plan that fits your week."], "caption": "Review meal suggestions that fit the preferences you provide.", "crop_from": [0.20, 0.48, 0.99, 0.984], "crop_to": [0.205, 0.486, 0.99, 0.985]},
            {"start": 20.2, "end": 26.4, "kind": "screen", "image": "dinner-groceries.png", "eyebrow": "04  /  CHOOSE WHAT TO BUY", "lines": ["The plan becomes a list."], "caption": "Take a reviewed meal plan into groceries. You choose what to buy and check out.", "crop_from": [0.185, 0.37, 0.995, 0.899], "crop_to": [0.19, 0.377, 0.995, 0.902]},
            {"start": 26.4, "end": 30, "kind": "end", "eyebrow": "ZELOS", "lines": ["Make room for dinner."], "caption": "Less planning dinner. More enjoying it. Explore Zelos at zelos-app.netlify.app."},
        ],
    },
]


def clamp(value, low=0.0, high=1.0):
    return min(high, max(low, value))


def smooth(value):
    value = clamp(value)
    return value * value * (3 - 2 * value)


class Renderer:
    def __init__(self, screens: Path, work: Path):
        self.screens, self.work = screens, work
        self.font_path = work / "hanken-medium.ttf"
        font = TTFont(ROOT / "website/fonts/hankengrotesk.woff2")
        font = instantiateVariableFont(font, {"wght": 500})
        font.flavor = None
        font.save(self.font_path)
        self.fonts = {}
        self.images = {}
        self.background = self.make_background()
        self.card_shadow = Image.new("RGBA", (WIDTH, HEIGHT))
        ImageDraw.Draw(self.card_shadow).rounded_rectangle((86, 181, 1194, 622), 17, fill=(28, 35, 23, 60))
        self.card_shadow = self.card_shadow.filter(ImageFilter.GaussianBlur(23))

    @staticmethod
    def make_background():
        # An original, very quiet light field, generated mathematically.
        small = Image.new("RGB", (320, 180))
        pix = small.load()
        for y in range(180):
            for x in range(320):
                glow = math.exp(-(((x - 240) / 150) ** 2 + ((y - 18) / 100) ** 2))
                shade = math.exp(-(((x - 50) / 200) ** 2 + ((y - 160) / 100) ** 2))
                pix[x, y] = tuple(int(clamp(c + 4 * glow - 7 * shade, 0, 255)) for c in PAPER)
        return small.resize((WIDTH, HEIGHT), Image.Resampling.BICUBIC)

    def font(self, size):
        if size not in self.fonts:
            self.fonts[size] = ImageFont.truetype(str(self.font_path), size)
        return self.fonts[size]

    def text(self, layer, value, pos, size=24, color=INK, opacity=1, centered=False, tracking=0):
        d = ImageDraw.Draw(layer)
        f = self.font(size)
        if tracking:
            width = sum(d.textlength(c, font=f) for c in value) + tracking * (len(value) - 1)
        else:
            width = d.textlength(value, font=f)
        x, y = pos
        if centered:
            x -= width / 2
        fill = (*color, int(255 * clamp(opacity)))
        if tracking:
            for char in value:
                d.text((x, y), char, font=f, fill=fill, anchor="lt")
                x += d.textlength(char, font=f) + tracking
        else:
            d.text((x, y), value, font=f, fill=fill, anchor="lt")
        return width

    def screen(self, name, crop, size):
        if name not in self.images:
            path = self.screens / name
            if not path.is_file():
                raise FileNotFoundError(f"A reviewed, current UI capture is required: {path}")
            self.images[name] = Image.open(path).convert("RGB")
        im = self.images[name]
        crop = tuple(round(c * (im.width if i % 2 == 0 else im.height)) for i, c in enumerate(crop))
        return ImageOps.fit(im.crop(crop), size, Image.Resampling.LANCZOS)

    def render_scene(self, scene, time):
        frame = self.background.copy().convert("RGBA")
        layer = Image.new("RGBA", (WIDTH, HEIGHT))
        elapsed = time - scene["start"]
        duration = scene["end"] - scene["start"]
        entrance = smooth(elapsed / 0.68)
        lift = (1 - entrance) * 22
        kind = scene["kind"]
        if kind == "screen":
            self.text(layer, scene["eyebrow"], (WIDTH / 2, 38 + lift), 13, MUTED, entrance, True, 1.65)
            self.text(layer, scene["lines"][0], (WIDTH / 2, 72 + lift), 49, INK, entrance, True)
            progress = smooth(clamp((elapsed - 0.65) / max(duration - 1.3, 1)))
            crop = [a + (b - a) * progress for a, b in zip(scene["crop_from"], scene["crop_to"])]
            screen = self.screen(scene["image"], crop, (1104, 450))
            mask = Image.new("L", screen.size)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, 1103, 449), radius=13, fill=255)
            frame.alpha_composite(self.card_shadow)
            screen_layer = Image.new("RGBA", (WIDTH, HEIGHT))
            screen_layer.paste(screen, (88, round(160 + lift)), mask)
            screen_layer.putalpha(screen_layer.getchannel("A").point(lambda a: int(a * entrance)))
            frame.alpha_composite(screen_layer)
            # Draw only explanatory typography outside the real UI capture.
            self.text(layer, scene["caption"], (WIDTH / 2, 642), 21, INK, entrance, True)
        elif kind == "title":
            self.text(layer, scene["eyebrow"], (WIDTH / 2, 171 + lift), 14, MUTED, entrance, True, 1.8)
            lines = scene["lines"]
            font_size = 79 if max(map(len, lines)) <= 22 else 70
            initial_y = 259 if len(lines) > 1 else 295
            for i, line in enumerate(lines):
                local = smooth((elapsed - 0.11 * i) / 0.78)
                self.text(layer, line, (WIDTH / 2, initial_y + i * 90 + (1 - local) * 28), font_size,
                          GREEN if i == scene.get("accent", -1) else INK, local, True)
            d = ImageDraw.Draw(layer)
            line_w = 46 * smooth((elapsed - 0.45) / 0.9)
            d.line((WIDTH / 2 - line_w / 2, 487, WIDTH / 2 + line_w / 2, 487), fill=(*GREEN, 200), width=2)
        else:
            self.text(layer, "ZELOS", (WIDTH / 2, 211 + lift), 20, MUTED, entrance, True, 7)
            self.text(layer, scene["lines"][0], (WIDTH / 2, 299 + lift), 76, INK, entrance, True)
            self.text(layer, "zelos-app.netlify.app", (WIDTH / 2, 418 + lift), 22, GREEN, entrance, True)
        self.text(layer, DISCLOSURE, (WIDTH / 2, 692), 12, MUTED, 1, True)
        frame.alpha_composite(layer)
        return frame.convert("RGB")

    def render(self, film, time):
        scenes = film["scenes"]
        scene_index = next((i for i, s in enumerate(scenes) if s["start"] <= time < s["end"]), len(scenes) - 1)
        scene = scenes[scene_index]
        frame = self.render_scene(scene, time)
        # Short, restrained dissolves. Screenshot content itself is never redrawn.
        if scene_index and time - scene["start"] < 0.28:
            previous = self.render_scene(scenes[scene_index - 1], scenes[scene_index - 1]["end"] - 0.001)
            frame = Image.blend(previous, frame, smooth((time - scene["start"]) / 0.28))
        if time < 0.20:
            frame = Image.blend(self.background, frame, smooth(time / 0.20))
        return frame


def write_soundtrack(path: Path, duration: float, variant: int):
    """Compose an original quiet score: soft harmonic pads and sparse bell notes."""
    sample_rate = 48000
    notes = [146.832, 183.498, 220.000, 293.665] if variant == 0 else [130.813, 163.516, 196.000, 261.626]
    pcm = array("h")
    # Purely synthesized tones; no samples, licensed tracks, or artist imitation.
    for n in range(round(duration * sample_rate)):
        t = n / sample_rate
        envelope = smooth(t / 1.6) * smooth((duration - t) / 1.9)
        left = right = 0.0
        for i, frequency in enumerate(notes):
            modulation = 0.65 + 0.35 * math.sin(t * 0.37 + i)
            tone = (math.sin(2 * math.pi * frequency * t) + 0.16 * math.sin(2 * math.pi * frequency * 2 * t))
            amplitude = 0.031 * modulation
            left += amplitude * tone * (0.78 + i * 0.05)
            right += amplitude * tone * (0.98 - i * 0.05)
        for beat, index in [(0.7, 2), (4.1, 0), (8.2, 1), (11.1, 3), (15.5, 2), (19.2, 1), (23.6, 0), (27.4, 3)]:
            local = t - beat
            if 0 <= local < 3.0:
                bell = math.sin(2 * math.pi * notes[index] * 4 * local) * math.exp(-local * 2.1) * smooth(local / 0.025) * 0.045
                left += bell * 0.84
                right += bell * 0.94
        pcm.extend((round(left * envelope * 32767), round(right * envelope * 32767)))
    if __import__("sys").byteorder != "little":
        pcm.byteswap()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def timestamp(seconds):
    millis = round(seconds * 1000)
    return f"{millis // 3600000:02}:{millis // 60000 % 60:02}:{millis // 1000 % 60:02}.{millis % 1000:03}"


def write_accessibility(film, output):
    vtt = ["WEBVTT", "", "NOTE On-screen text for a caption-led film. No spoken dialogue.", ""]
    transcript = [film["title"], "=" * len(film["title"]), "", film["description"], "", DISCLOSURE + ".", "", "This edited product walkthrough uses actual interface captures and fictional records. The soundtrack is original instrumental audio, with no spoken narration. All narrative text appears on screen.", ""]
    for i, scene in enumerate(film["scenes"], 1):
        text = scene["caption"]
        cue = "\n".join([scene["lines"][0], text]) if scene["kind"] == "screen" else text
        vtt.extend([str(i), f"{timestamp(scene['start'])} --> {timestamp(scene['end'])}", cue, ""])
        transcript.append(f"{timestamp(scene['start'])[:-4]}–{timestamp(scene['end'])[:-4]}  {text}")
        if scene["kind"] == "screen":
            transcript.append(f"On screen: {scene['lines'][0]} The Zelos {SCREEN_LABELS[scene['image']]}.")
        transcript.append("")
    if film["slug"] == "make-room-for-dinner":
        transcript.extend(["Meal suggestions are reviewed by you. Grocery purchasing, cooking, and cleanup are not automated in this preview.", ""])
    (output / f"{film['slug']}.vtt").write_text("\n".join(vtt))
    (output / f"{film['slug']}.txt").write_text("\n".join(transcript))


def render_film(renderer, film, output, ffmpeg, variant):
    slug = film["slug"]
    sound_path = renderer.work / f"{slug}.wav"
    video_path = output / f"{slug}.mp4"
    write_soundtrack(sound_path, film["duration"], variant)
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0", "-i", str(sound_path), "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", str(film["duration"]), "-metadata", f"title=Zelos — {film['title']}", "-metadata", "comment=Original edited walkthrough. Fictional records. Current preview interface.", str(video_path)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for frame_index in range(round(film["duration"] * FPS)):
            process.stdin.write(renderer.render(film, frame_index / FPS).tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError(f"ffmpeg could not render {slug}")
    except BaseException:
        process.kill()
        process.wait()
        raise
    renderer.render(film, film["poster_time"]).save(output / f"{slug}.jpg", quality=94, subsampling=0)
    write_accessibility(film, output)
    # A contact sheet is a review artifact, never part of the public website.
    samples = [0.9] + [(s["start"] + s["end"]) / 2 for s in film["scenes"][1:]]
    sheet = Image.new("RGB", (960, math.ceil(len(samples) / 2) * 270), PAPER)
    for i, time in enumerate(samples):
        tile = renderer.render(film, time).resize((480, 270), Image.Resampling.LANCZOS)
        sheet.paste(tile, ((i % 2) * 480, (i // 2) * 270))
    sheet.save(renderer.work / f"{slug}-contact.jpg", quality=94)
    return {"slug": slug, "title": film["title"], "description": film["description"], "durationSeconds": film["duration"], "width": WIDTH, "height": HEIGHT, "fps": FPS, "bytes": video_path.stat().st_size, "sha256": hashlib.sha256(video_path.read_bytes()).hexdigest(), "previewVersion": VERSION}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screens", type=Path, default=Path(__file__).resolve().parent / "captures")
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "website/video")
    parser.add_argument("--film", choices=[film["slug"] for film in FILMS])
    parser.add_argument("--frames-only", action="store_true", help="Render contact sheets and posters for an early visual review.")
    args = parser.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    films = [f for f in FILMS if not args.film or f["slug"] == args.film]
    required = {s["image"] for film in films for s in film["scenes"] if "image" in s}
    for name in required:
        if not (args.screens / name).is_file():
            parser.error(f"Missing reviewed current UI screenshot: {args.screens / name}")
    renderer = Renderer(args.screens, args.work)
    if args.frames_only:
        for film in films:
            for index, scene in enumerate(film["scenes"]):
                renderer.render(film, (scene["start"] + scene["end"]) / 2).save(args.work / f"{film['slug']}-scene-{index + 1}.jpg", quality=94)
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("ffmpeg with libx264 is required")
    existing_manifest = args.output / "films.json"
    previous = json.loads(existing_manifest.read_text()).get("films", []) if args.film and existing_manifest.exists() else []
    manifest_by_slug = {film["slug"]: film for film in previous}
    for index, film in enumerate(films):
        print(f"Rendering {film['title']} ({film['duration']}s)", flush=True)
        manifest_by_slug[film["slug"]] = render_film(renderer, film, args.output, ffmpeg, FILMS.index(film))
    manifest = [manifest_by_slug[film["slug"]] for film in FILMS if film["slug"] in manifest_by_slug]
    (args.output / "films.json").write_text(json.dumps({"films": manifest}, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
