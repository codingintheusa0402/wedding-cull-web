// End-to-end in a real browser: open the site, give it a folder, wait for the review, score against truth.csv.
// usage: PLAYWRIGHT=<path to playwright-core> CHROME=<chromium binary> node tests/e2e.cjs URL FOLDER [OUT_DIR]
const fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");
const [url, folder, out] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(url);
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.webkitdirectory = true; i.id = "t"; i.onchange = () => WCApp.openFileList(Array.from(i.files)); document.body.appendChild(i); });
  const t0 = Date.now();
  await page.setInputFiles("#t", folder);
  await page.waitForSelector("#review:not([hidden])", { timeout: 600000 });
  const secs = (Date.now() - t0) / 1000;
  const res = await page.evaluate(() => ({ stats: WCApp.S.stats, faceError: WCApp.S.faceError,
    rows: WCApp.S.results.map((r) => ({ name: r.name, status: r.status, role: r.role, primary: r.primary, faces: r.n_faces, blink: r.max_blink, error: r.error, fb: (r.f && r.f.faces || []).map((x) => [x.x, x.y, x.w, x.h, x.sharp]) })) }));
  console.log(`analysed ${res.stats.photos} photos in ${secs.toFixed(1)} s (page says ${res.stats.seconds.toFixed(1)} s), faceError=${res.faceError}`);
  const truthF = path.join(folder, "truth.csv");
  if (fs.existsSync(truthF)) {
    const lines = fs.readFileSync(truthF, "utf8").trim().split("\n"); const h = lines[0].split(",");
    const truth = Object.fromEntries(lines.slice(1).map((l) => { const c = l.split(","); return [c[0], Object.fromEntries(h.map((k, i) => [k, c[i]]))]; }));
    let ok = 0, n = 0; const bad = [];
    const col = h.find((k) => /expect|truth|verdict/i.test(k) && k !== "file") || h[1];
    for (const r of res.rows) { const t = truth[r.name]; if (!t) continue; n++; const want = t[col];
      const got = r.status; if (want === got || (want === "keep" && got === "ok") || (want === "flag" && got !== "ok")) ok++; else bad.push(`${r.name}: want ${want} got ${got} (${r.primary}) faces=${r.faces} ${r.error || ""}`); }
    console.log(`truth column "${col}": ${ok}/${n} match`); bad.forEach((b) => console.log("  " + b));
  }
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "web_results.json"), JSON.stringify(res.rows, null, 1));
    await page.screenshot({ path: path.join(out, "overview.png") });
  }
  if (errs.length) { console.log("page errors:"); errs.slice(0, 10).forEach((e) => console.log("  " + e.slice(0, 300))); }
  await browser.close();
})();
