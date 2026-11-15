// Full flow in a real browser, through the real File System Access code: the folder lives in the browser's
// private file system (OPFS) and showDirectoryPicker() returns it. Analyse -> review -> Save to folder ->
// read the written files back. Also captures README screenshots.
// usage: PLAYWRIGHT=... CHROME=... node tests/flow.cjs URL FOLDER OUT_DIR [--shots] [--dark]
const fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");
const [url, folder, out] = process.argv.slice(2);
const SHOTS = process.argv.includes("--shots"), DARK = process.argv.includes("--dark");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1,
    colorScheme: DARK ? "dark" : "light" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("NAVIGATED", f.url()); });
  page.on("crash", () => console.log("CRASHED"));
  const shot = async (name, opts = {}) => { if (SHOTS) await page.screenshot(Object.assign({ path: path.join(out, name) }, opts)); };
  await page.goto(url);

  // copy the folder into OPFS and make the picker return it
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.webkitdirectory = true; i.id = "t"; i.hidden = true; document.body.appendChild(i); });
  await page.setInputFiles("#t", folder);
  const name = path.basename(folder);
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(name, { recursive: true }); } catch {}
    const dir = await root.getDirectoryHandle(name, { create: true });
    for (const f of document.getElementById("t").files) {
      const rel = f.webkitRelativePath.split("/").slice(1);
      if (rel.length !== 1) continue;
      const w = await (await dir.getFileHandle(rel[0], { create: true })).createWritable();
      await w.write(f); await w.close();
    }
    window.showDirectoryPicker = async () => dir;
  }, name);
  await shot("01-start.png");

  const t0 = Date.now();
  await page.click("#pick");
  await page.waitForSelector("#progress:not([hidden])");
  if (SHOTS) {
    await page.waitForFunction(() => +document.getElementById("progN").textContent.replace(/,/g, "") >= 18, null, { timeout: 120000 });
    await shot("02-progress.png");
  }
  await page.waitForSelector("#review:not([hidden])", { timeout: 600000 });
  const secs = (Date.now() - t0) / 1000;
  await sleep(600);
  await shot("03-overview.png");
  const stats = await page.evaluate(() => WCApp.S.stats);
  console.log(`analysed ${stats.photos} photos in ${secs.toFixed(1)} s`);

  // rejects view, a lightbox, bursts, apps
  await page.click('.side a[data-v="reject"]'); await sleep(500);
  await shot("04-rejects.png");
  if (SHOTS) {
    await page.click('.side a[data-v="bursts"]'); await sleep(500);
    await shot("05-bursts.png");
    await page.click('#content .card.best');
    await page.waitForFunction(() => { const i = document.getElementById("lbImg"); return i.src.startsWith("blob:") && i.naturalWidth > 1000; }, null, { timeout: 60000 }).catch(() => {});
    await sleep(400);
    await shot("06-lightbox.png");
    await page.keyboard.press("Escape");
    await page.click('.side a[data-v="apps"]'); await sleep(300);
    await shot("07-apps.png");
  }

  // a decision, then save through the real code path
  const firstReject = await page.evaluate(() => (WCApp.S.results.find((r) => r.status === "reject") || {}).name);
  if (firstReject) {
    await page.click('.side a[data-v="reject"]'); await sleep(200);
    await page.focus("#content .card"); await page.keyboard.press("k"); await sleep(200);
  }
  await page.click("#saveBtn");
  await page.waitForSelector("#mGo");
  if (SHOTS) await shot("08-save.png");
  await page.click("#mGo");
  await page.waitForFunction(() => WCApp.lastSave, null, { timeout: 300000 });
  const saved = await page.evaluate(() => WCApp.lastSave);
  console.log("save:", JSON.stringify(Object.assign({}, saved, { failed: saved.failed.length })));
  if (saved.failed.length) console.log(saved.failed.slice(0, 5));

  // read back: every written JPEG + the _cull files
  const back = await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
    const b64 = async (h) => { const b = new Uint8Array(await (await h.getFile()).arrayBuffer()); let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
    const files = {};
    for await (const [n, h] of dir.entries()) if (h.kind === "file") files[n] = await b64(h);
    const cull = await dir.getDirectoryHandle("_cull");
    for await (const [n, h] of cull.entries()) if (h.kind === "file") files["_cull/" + n] = Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer()));
    return files;
  }, name);
  const dst = path.join(out, "saved");
  fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(path.join(dst, "_cull"), { recursive: true });
  for (const [n, b] of Object.entries(back)) fs.writeFileSync(path.join(dst, n), Buffer.from(b, "base64"));
  console.log(`read back ${Object.keys(back).length} files into ${dst}; kept by hand: ${firstReject}`);
  if (errs.length) { console.log("page errors:"); errs.slice(0, 8).forEach((e) => console.log("  " + e.slice(0, 300))); }
  await browser.close();
})();
