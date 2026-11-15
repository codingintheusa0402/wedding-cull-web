# Changelog

## 0.3.0 - 2026-11-15

A new look; every function, check, decision and file written is the same as 0.2.2 (parity, e2e, flow and XMP tests
unchanged).

- **Dark by default** like an editing app, with a light mode (sun / moon button, remembered). Graphite surfaces so the
  photos carry the colour; the icon's orange-to-pink only on the main action, progress and the best of each burst.
- **Focus brackets** (the icon's motif) mark the photo you are on, the best frame of a burst, and snap in, in the
  decision's colour, when you mark a photo keep / reject / check.
- **Type**: Pretendard (Korean and Latin) with Archivo for headlines and numbers, both self-hosted (no font requests to
  other servers). Korean never breaks inside a word.
- **Start page**: the real app running next to one clear **Choose a folder** / **폴더 선택** button, three short benefit
  lines, settings below.
- **Analysing**: a large live count, the photos landing on a contact sheet (still placeholders first), and live
  reject / check / keep counters. Same speed as 0.2.2.
- **Review**: photo-first cards with status chips and custom icons for every check; the keep / reject / check buttons
  show each photo's current status; the overview shows the four groups that add up to the total on one proportional
  bar; bursts as film strips; the full-size view lists which checks passed.
- **Help and contact**: a **?** menu (top right) and **문의 · 버그 제보** / **Contact and bug reports** (start page)
  open the Hello World Instagram profile (@he110w0r1.oi), GitHub Issues, the guide and the source. A feedback form
  slot is ready (`CONTACT.form` in app.js) but not set yet.
- Narrow screens: save actions first in the toolbar, categories as a chip row, one-column landing with the demo above
  the fold. Keyboard focus is visible everywhere; reduced-motion turns off animations and the demo video autoplay.
- README: new screenshots (dark; light overview and bursts; phone width), Contact section.

## 0.2.2 - 2026-11-15

- Only what is tested is promised: **Mac · Chrome / Safari**. Firefox and Windows are marked "testing soon"
  (테스트 예정) on the site and in the README; the hints now say "use Chrome" instead of "Chrome or Edge (Mac and
  Windows)".
- Subline under the headline: "Free culling for wedding, snap and studio photographers" /
  "웨딩 · 스냅 · 스튜디오 작가를 위한 무료 셀렉 도구".
- README: Roadmap section (Firefox/Windows testing; obstruction check with on-device person detection, not ported
  from the desktop because it is unreliable).
- tests/flow.cjs: the "kept by hand" line names the photo it actually kept (the first card on the Rejects page).

## 0.2.1 - 2026-11-15

- **Not just weddings**: the headline now says "Cull 2,000 photos in minutes, not evenings" /
  "사진 2,000장 셀렉, 저녁 내내가 아니라 몇 분이면". The app name stays Wedding Cull.
- **New icon**: white focus brackets and a focus dot on an orange-to-pink gradient (clearer at small sizes than
  0.2.0's stacked frames). Favicon, Apple touch icon, PWA icons, README and the social preview updated.
- README media re-recorded with the new headline and icon.

## 0.2.0 - 2026-11-15

- **Korean** (한국어): every screen, button, message and the Save dialog. Follows the browser language, a
  한국어 / English button at the top right switches and is remembered. Check names: 실수 컷, 흔들림·초점,
  초점 빗나감, 눈 감음, 너무 어두움, 너무 밝음; keep / reject / check = 남김 / 제외 / 확인. XMP keywords stay
  English (`Culling|…`) so existing Lightroom / Bridge filters keep working.
- **Plain-language reasons** on every card and in the full-size view ("Camera shake: the picture is smeared");
  the measurements are behind **Show technical details** (remembered).
- **Keep the 1 to 5 best of each burst** (start screen and Bursts page, default 1 = as before). The extra keepers
  get ★★★ and the "Best of burst" keyword like the first one; the keeper column in results.csv is still the best one.
- **New icon**: stacked frames resolving to one gold pick. PNG favicon, Apple touch icon and a web app manifest
  (installable from Chrome / Edge).
- README media re-recorded.
- Fixes: toolbar labels no longer break mid-word on narrow screens (the bar scrolls sideways); the overview's last
  tile now shows **Kept** (same number as the sidebar) instead of "keepers" (which also counted photos to check);
  the Korean kicker is not upper-cased ("MAC과").

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
