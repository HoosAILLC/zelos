# Zelos product films

Two original, caption-led product films use current Zelos interface captures and
fictional demo records. The videos are edited walkthroughs, not screen recordings
of a continuous session. They contain no third-party footage, music, or logos.
The original instrumental soundtrack is synthesized by the renderer.

## Rebuild

Requires Python with Pillow and fontTools (including WOFF2 support), and ffmpeg
with libx264. The renderer reuses the site's bundled Hanken Grotesk font.
The reviewed fictional captures in `scripts/video/captures/` are the default
inputs. To rebuild from them, omit `--screens` in the commands below.

Capture these screens through the supported browser screenshot API, with the
current app UI and the fictional website demo adapter. Store them in a temporary
capture directory. Do not capture real user accounts or private records.

- `morning-now.png`: the Now overview, with populated meetings and commitments.
- `morning-ask.png`: a completed meeting brief, with visible source references.
- `dinner-health.png`: food preferences or the Health overview.
- `dinner-discovery.png`: the current meal Discovery view with recipe cards.
- `dinner-meal-plan.png`: a reviewed, populated meal plan.
- `dinner-groceries.png`: the grocery list created from the reviewed plan.

For example, using scratch directories outside the repository:

```sh
python3 scripts/video/build-films.py \
  --screens /tmp/zelos-film-screens \
  --work /tmp/zelos-film-render \
  --frames-only
```

Inspect every sample frame first. Remove `--frames-only` to render the MP4s,
posters, on-screen-text WebVTT tracks, plain-text transcripts, and metadata into
`website/video/`. The public outputs are 1280×720 H.264, 24 fps, YUV420p, AAC, with
fast-start metadata. The source screenshots are not copied into the public site.
After rendering, run `python3 scripts/video/check-films.py` to fully decode both
films and check the codec, duration, fast-start atoms, hashes, and companion files.

The films always identify the preview version, fictional data, and editing.
Claims describe the features shown. They do not imply automatic purchases,
autonomous driving, robot control, medical recommendations, or measured time
savings. The dinner story leaves review and checkout with the user.

The website should load videos only on request, provide native playback controls,
and offer the corresponding transcript. Use the WebVTT track label “On-screen
text”; there is no spoken narration. Keep any ambient soundtrack muted until the
visitor chooses playback or sound. Respect reduced motion on surrounding page
animations and never require watching a film to understand the feature.
