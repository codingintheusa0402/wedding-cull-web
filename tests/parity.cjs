// Parity with the desktop engine: same decoded pixels + same face boxes -> same features and verdicts.
// usage: node tests/parity.cjs PARITY_DIR   (made by the desktop repo's dump script; see tests/README.md)
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
global.self = globalThis;
const cv0 = require(path.join(__dirname, "../vendor/opencv/opencv.js"));
require("../engine/core.js"); require("../engine/analyze.js");
const WC = globalThis.WC;
const KEYS = ["tile_sharp", "tile_sharp_max", "tile_energy", "spread", "median", "p02", "p98", "std", "clip_hi",
  "clip_lo", "edge_density", "global_sharp"];
const FACE_KEYS = ["sharp", "energy", "spread", "clip", "luma"];
function run(cv) {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  const worst = {}; let hashDiff = 0; const feats = [];
  for (const it of idx) {
    const rgb = fs.readFileSync(path.join(dir, it.id + ".rgb"));
    const rgba = new Uint8Array(it.w * it.h * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }
    const mat = cv.matFromArray(it.h, it.w, cv.CV_8UC4, rgba);
    const py = it.py;
    const faces = (py.faces || []).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, conf: f.conf, quality: f.quality, yaw: f.yaw, blink: f.blink }));
    const f = WC.analyzeImage(cv, mat, faces, py.meta); mat.delete();
    for (const k of KEYS) {
      if (py[k] == null || f[k] == null) continue;
      const rel = Math.abs(f[k] - py[k]) / Math.max(Math.abs(py[k]), 1e-3);
      if (!worst[k] || rel > worst[k][0]) worst[k] = [rel, py.name, py[k], f[k]];
    }
    (py.faces || []).forEach((pf, i) => { const jf = f.faces[i]; if (!jf) return; for (const k of FACE_KEYS) {
      if (pf[k] == null || jf[k] == null) continue;
      const rel = Math.abs(jf[k] - pf[k]) / Math.max(Math.abs(pf[k]), 1e-3);
      if (!worst["face." + k] || rel > worst["face." + k][0]) worst["face." + k] = [rel, py.name, pf[k], jf[k]];
    } });
    hashDiff = Math.max(hashDiff, WC.hamming(f.phash, py.phash));
    // keep the desktop's own face values for blink/quality (Apple Vision gives face quality; MediaPipe does not)
    f.faces.forEach((jf, i) => { const pf = py.faces[i]; if (pf) { jf.quality = pf.quality; } });
    feats.push(Object.assign(f, { id: py.id, path: py.path, name: py.name }));
  }
  console.log("max relative difference per feature (python vs web):");
  for (const [k, v] of Object.entries(worst)) console.log(`  ${k.padEnd(16)} ${(v[0] * 100).toFixed(3)}%  ${v[1]} ${v[2]} -> ${v[3]}`);
  console.log("  phash max hamming", hashDiff);
  // verdicts
  const py = {}; const lines = fs.readFileSync(path.join(dir, "py_results.csv"), "utf8").trim().split("\n");
  const hdr = lines[0].split(",");
  for (const l of lines.slice(1)) { const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "")); py[c[0]] = { status: c[hdr.indexOf("status")], role: c[hdr.indexOf("role")], primary: c[hdr.indexOf("primary_reason")] }; }
  const res = WC.decideAll(feats, WC.config("normal"));
  let same = 0; const diffs = [];
  for (const r of res) { const p = py[r.name]; if (p && p.status === r.status && p.role === r.role && p.primary === (WC.LABELS[r.primary] || "")) same++; else diffs.push(`${r.name}: py ${JSON.stringify(p)} web ${r.status}/${r.role}/${r.primary}`); }
  console.log(`verdicts identical: ${same}/${res.length}`); diffs.forEach((d) => console.log("  " + d));
  process.exit(diffs.length ? 1 : 0);
}
if (cv0.Mat) run(cv0); else cv0.onRuntimeInitialized = () => run(cv0);
