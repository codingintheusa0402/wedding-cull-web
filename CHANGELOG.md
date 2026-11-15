# Changelog

## 0.1.0 - 2026-11-15

First public version: the Wedding Cull engine in the browser.

- Checks: blur and camera shake, missed focus, closed eyes, too dark / too bright (exposure-compensation aware),
  accidental frames; bursts grouped with the best frame starred. Strictness gentle / normal / strict.
- Engine ported line by line from the desktop tool on OpenCV.js (identical features and verdicts on the same pixels);
  faces by YuNet mapped to Apple Vision's box geometry, blinks by MediaPipe Face Landmarker.
- JPEG and RAW (ARW, CR3, CR2, NEF, DNG, RAF, ORF, RW2 through their embedded preview), EXIF capture time and
  sub-seconds, RAW+JPEG pairs.
- Review: rejects and photos to check grouped by reason, bursts, kept, full-size view; K / R / C / U, arrows,
  multi-select, ⌘+ / ⌘− thumbnail size; decisions and analysis remembered per folder in the browser.
- Lightroom Classic, Adobe Bridge and Photoshop: XMP inside JPEGs (image data untouched, verified before writing),
  sidecars for RAW (existing Camera Raw sidecars merged and backed up), label name per app, Photoshop scripts that
  open the keepers / the photos to check; results.csv and overrides.csv compatible with the desktop tool.
- Chrome / Edge save straight into the folder; Safari / Firefox download a ZIP of sidecars.
