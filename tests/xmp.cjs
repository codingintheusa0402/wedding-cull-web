// XMP writing in a real browser: embed into a JPEG (image data untouched), merge into an existing packet.
// usage: PLAYWRIGHT=... CHROME=... node tests/xmp.cjs URL JPEG OUT_DIR
const fs = require("fs"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright-core");
const [url, jpeg, out] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const page = await browser.newPage();
  await page.goto(url);
  const src = Array.from(fs.readFileSync(jpeg));
  const res = await page.evaluate((src) => {
    const b = new Uint8Array(src);
    const r = { status: "reject", role: "single", reasons: ["blur"], override: null };
    const p1 = WC.plan(r, { check_label: "Second" });
    const a = WC.jpegWithXmp(b, WC.renderXmp(p1));                     // first write: new packet
    // someone (Camera Raw) adds settings + a keyword; then we re-cull as "check"
    let x = WC.jpegXmp(a).replace('xmp:Rating="-1"', 'xmp:Rating="-1"\n    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50"')
      .replace("<rdf:li>Reject</rdf:li>", "<rdf:li>Reject</rdf:li><rdf:li>Bride</rdf:li>");
    const a2 = WC.jpegWithXmp(a, x);
    const p2 = WC.plan({ status: "check", role: "best", reasons: ["eyes"], override: null }, { check_label: "Second" });
    const merged = WC.mergeXmp(WC.jpegXmp(a2), p2, WC.OUR_KEYWORDS, WC.OUR_LABELS);
    const c = WC.jpegWithXmp(a2, merged);
    return { first: Array.from(a), final: Array.from(c), merged };
  }, src);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "first.jpg"), Buffer.from(res.first));
  fs.writeFileSync(path.join(out, "final.jpg"), Buffer.from(res.final));
  fs.writeFileSync(path.join(out, "merged.xmp"), res.merged);
  console.log("wrote", out);
  await browser.close();
})();
