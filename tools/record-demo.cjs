// Records the README demo: the real app driven by a script, captured with Chrome's screencast (2x), with a
// visible cursor. Writes numbered JPEG frames + frames.txt (ffmpeg concat with real durations).
// usage: PLAYWRIGHT=... CHROME=... node tools/record-demo.cjs URL FOLDER OUT_DIR [--dark]
const fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");
const [url, folder, out] = process.argv.slice(2);
const DARK = process.argv.includes("--dark");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: DARK ? "dark" : "light" });
  const page = await ctx.newPage();
  await page.goto(url);
  // the folder in the browser's private file system; the picker returns it (same as tests/flow.cjs)
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
      const w = await (await dir.getFileHandle(rel[0], { create: true })).createWritable(); await w.write(f); await w.close();
    }
    window.showDirectoryPicker = async () => dir;
    const c = document.createElement("div"); c.id = "democursor";
    c.style.cssText = "position:fixed;z-index:9999;left:0;top:0;width:22px;height:22px;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 11-7 1-3.5 7z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { c.style.transform = "translate(-3px,-2px) scale(.82)"; }, true);
    addEventListener("mouseup", () => { c.style.transform = "translate(-3px,-2px)"; }, true);
  }, name);
  await page.mouse.move(980, 620);

  // screencast
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1 });
  const move = async (sel, opts = {}) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.mouse.move(b.x + b.width * (opts.fx || 0.5), b.y + b.height * (opts.fy || 0.5), { steps: opts.steps || 22 });
    return b;
  };
  const click = async (sel, opts) => { await move(sel, opts); await sleep(180); await page.mouse.down(); await sleep(90); await page.mouse.up(); };

  await sleep(1400);
  await click("#pick");
  await page.waitForSelector("#review:not([hidden])", { timeout: 600000 });
  await sleep(1800);                                   // overview
  await click('.side a[data-v="reject"]'); await sleep(1300);
  await page.mouse.wheel(0, 420); await sleep(1200);
  await click('.side a[data-v="bursts"]'); await sleep(1500);
  await click("#content .card.best .im");               // full size
  await page.waitForFunction(() => { const i = document.getElementById("lbImg"); return i.src.startsWith("blob:") && i.naturalWidth > 1000; }, null, { timeout: 60000 }).catch(() => {});
  await sleep(1200);
  await move(".lb-side .strip img:nth-child(2)"); await sleep(250);
  await page.mouse.down(); await page.mouse.up(); await sleep(1500);
  await page.keyboard.press("Escape"); await sleep(500);
  await click('.side a[data-v="apps"]'); await sleep(2000);
  await click("#saveBtn"); await page.waitForSelector("#mGo"); await sleep(1500);
  await click("#mGo");
  await page.waitForFunction(() => WCApp.lastSave, null, { timeout: 300000 });
  await sleep(2600);
  await cdp.send("Page.stopScreencast");

  // frames + durations (ffmpeg concat demuxer)
  let list = "";
  frames.forEach((f, i) => {
    const fn = `f${String(i).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(out, fn), Buffer.from(f.data, "base64"));
    const dur = i + 1 < frames.length ? Math.max(0.02, frames[i + 1].t - f.t) : 1.5;
    list += `file '${fn}'\nduration ${dur.toFixed(3)}\n`;
  });
  list += `file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'\n`;
  fs.writeFileSync(path.join(out, "frames.txt"), list);
  console.log(`${frames.length} frames, ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)} s`);
  await browser.close();
})();
