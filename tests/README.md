# Tests

All of them need the site served locally (`python3 -m http.server 8765` in the repo root) and, for the browser tests,
[`playwright-core`](https://www.npmjs.com/package/playwright-core) with a Chromium build (`CHROME=<path>`). Headless
Chromium has no GPU, so the browser tests start it with SwiftShader (software WebGL) for MediaPipe.

| Test | What it proves |
|---|---|
| `node tests/parity.cjs DIR` | On the same decoded pixels and face boxes, the web engine computes the same features and verdicts as the desktop Python engine. `DIR` holds `index.json` + raw RGB dumps made from a desktop run (see below). |
| `node tests/e2e.cjs URL FOLDER [OUT]` | The whole analysis in a real browser (workers, OpenCV.js, YuNet, MediaPipe) on a folder; scores against `truth.csv` if present and writes `web_results.json`. |
| `node tests/flow.cjs URL FOLDER OUT [--shots] [--dark]` | The full flow through the real File System Access code (the folder lives in the browser's private file system): analyse, decide, **Save to folder**, read the written files back. `--shots` captures the README screenshots. |
| `node tests/xmp.cjs URL JPEG OUT` | XMP inside a JPEG: first write, then a merge into a packet that already has Camera Raw settings and a user keyword. Check the output with `exiftool` and compare pixels. |

Making a parity set from the desktop tool (`wedding-cull`, Python): run `cull FOLDER --no-xmp`, then dump each photo's
2048 px preview as raw RGB plus its features:

```python
from wedding_cull.loader import load_preview   # in the desktop repo
for r in features:                             # rows of FOLDER/_cull/features.jsonl
    rgb, _ = load_preview(Path(r["path"]), r["meta"].get("orientation"), 2048)
    (out / f"{r['id']}.rgb").write_bytes(rgb.tobytes())
# index.json: [{"id", "w", "h", "py": <the features row>}], plus py_results.csv = FOLDER/_cull/results.csv
```

`tools/record-demo.cjs` records the README demo (Chrome screencast at 2x, scripted cursor); encode with ffmpeg as
shown in its header.
