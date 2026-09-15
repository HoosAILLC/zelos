# Zelos lifestyle films

Two 30-second, live-action promotional edits with an original synthesized instrumental score. Public files live in `website/video/`; `threshold.mp4` is a separate existing brand asset and is not changed by this pipeline.

The films use eight individually reviewed Mixkit **Stock Video Free License** clips. `stock-sources.json` records source pages, exact download URLs, and license evidence. Each individual source page explicitly permits commercial and personal use. A Restricted License candidate was rejected. Raw footage is **not** part of this repository, is not redistributed by Zelos, and is not MIT licensed. Obtain the selected sources under their own license and keep them in an external working directory with the filenames in the manifest. See the public `/video/credits.html` page for attribution and context.

## Build

Requires Python 3 with Pillow and fontTools (WOFF2 support), and FFmpeg with libx264/AAC. The script derives its typography from the site’s Hanken Grotesk font. It does not fetch footage, use a video-generation service, capture a browser, or require a production account.

```sh
python3 scripts/video/build-films.py \
  --sources /path/to/licensed-source-cache \
  --work /path/to/external-render-work
python3 scripts/video/check-films.py
```

Optional `--film a-clearer-day` or `--film make-room-for-dinner`, and `--variant landscape` or `--variant portrait`, allow a targeted revision. Each run refreshes the selected manifest entries, accessible text, and review sheets. The work directory holds uncaptioned picture masters, original audio, overlay strips, and contact sheets; none are website downloads.

## Editorial choices

- Both cuts are exactly 720 frames at 24 fps (30 seconds).
- Landscape is 1920×1080. Portrait is 720×1280 with a separately chosen crop for every shot, reviewed across the action.
- Continuous source motion fills every scene. Six-frame dissolves connect four shots. Text fades quietly over footage; there are no screenshot slides or simulated interface animations.
- Frame timestamps are retimed before the 24 fps normalization. Native 23.976 footage runs 0.1% faster; the 30 fps forest clip runs at 80% speed. This retains the chosen source frames instead of dropping every fifth frame.
- H.264 video, 4:2:0 pixels, AAC stereo audio, and fast-start MP4 metadata support Safari/iOS, Chrome/Android, Edge/Windows, and macOS browsers.
- Posters are uncaptioned frames from the outdoor or shared-dinner scene, including an independently framed portrait poster.
- On-screen text is also supplied as optional WebVTT and a transcript. There is no spoken narration. The site starts video only on a user action.
- Small “Dramatized scenes” labels appear at the beginning and end. Actors are illustrative, not testimonials. There are no numerical savings claims, autonomous shopping, robot cooking, or unsupported integration demonstrations.

## Review

`check-films.py` verifies codec, dimensions, duration, frame count, audio, web streaming layout, matching metadata/hashes, poster dimensions, and complete decoding of all four files. Generated contact sheets must also be visually inspected for text, action, and subject framing. Rendered files should be watched in the actual desktop and mobile players before publishing. Automated codec checks do not by themselves prove every device was tested.
