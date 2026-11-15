/* Wedding Cull web: reading photos (EXIF, embedded RAW previews) and writing metadata (XMP sidecars, the XMP block
   inside JPEGs) - without ever re-encoding image data. Plus a tiny store-only ZIP writer for downloads. */
(function (root) {
  "use strict";
  const WC = root.WC = root.WC || {};

  WC.RAW_EXT = new Set(["arw", "cr3", "cr2", "nef", "dng", "raf", "orf", "rw2"]);
  WC.JPEG_EXT = new Set(["jpg", "jpeg"]);
  WC.SKIP_DIRS = new Set(["_cull", "_rejects", "_removed", "_shots", "_originals"]);
  WC.ext = (name) => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); };
  WC.stem = (name) => { const i = name.lastIndexOf("."); return i < 0 ? name : name.slice(0, i); };

  /** list -> {photos, companions}: a JPEG shot with a RAW of the same stem travels with the RAW (not analysed). */
  WC.pairPhotos = function (entries) {
    const by = new Map();
    for (const e of entries) {
      const dir = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : "";
      const key = dir + "\u0000" + WC.stem(e.name).toLowerCase();
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(e);
    }
    const photos = [], companions = new Map();
    for (const g of by.values()) {
      const raws = g.filter((e) => WC.RAW_EXT.has(WC.ext(e.name))).sort((a, b) => (a.rel < b.rel ? -1 : 1));
      if (raws.length) {
        photos.push(raws[0]);
        const others = g.filter((e) => e !== raws[0]);
        if (others.length) companions.set(raws[0].rel, others);
      } else photos.push(...g);
    }
    photos.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { photos, companions };
  };

  // ------------------------------------------------------------------ TIFF / EXIF
  function tiffTags(b, start) {
    if (start + 8 > b.length) return null;
    const le = b[start] === 0x49 && b[start + 1] === 0x49;
    const be = b[start] === 0x4d && b[start + 1] === 0x4d;
    if (!le && !be) return null;
    const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216
      : b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
    const s32 = (o) => { const v = u32(o); return v > 0x7fffffff ? v - 0x100000000 : v; };
    const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const out = {};
    const readIfd = (off, depth) => {
      const o = start + off;
      if (off <= 0 || o + 2 > b.length || depth > 2) return;
      const n = u16(o);
      for (let i = 0; i < n && i < 400; i++) {
        const e = o + 2 + i * 12;
        if (e + 12 > b.length) break;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const size = (SIZES[type] || 1) * cnt;
        const vo = size <= 4 ? e + 8 : start + u32(e + 8);
        if (vo + size > b.length) continue;
        let v;
        if (type === 2) { let s = ""; for (let k = 0; k < cnt && b[vo + k]; k++) s += String.fromCharCode(b[vo + k]); v = s.trim(); }
        else if (type === 3) v = u16(vo);
        else if (type === 4) v = u32(vo);
        else if (type === 5) v = u32(vo + 4) ? u32(vo) / u32(vo + 4) : null;
        else if (type === 10) v = s32(vo + 4) ? s32(vo) / s32(vo + 4) : null;
        else if (type === 7 && cnt <= 32) { let s = ""; for (let k = 0; k < cnt && b[vo + k]; k++) s += String.fromCharCode(b[vo + k]); v = s; }
        else continue;
        if (!(tag in out)) out[tag] = v;
        if (tag === 0x8769) readIfd(v, depth + 1); // Exif IFD
      }
    };
    readIfd(u32(start + 4), 0);
    return out;
  }

  function findBytes(b, pat, from = 0, to = b.length) {
    outer: for (let i = from; i <= Math.min(to, b.length) - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

  /** EXIF block of a JPEG (APP1 "Exif\0\0") -> tags */
  function jpegExif(b) {
    let o = 2;
    while (o + 4 < b.length && b[o] === 0xff) {
      const m = b[o + 1];
      if (m === 0xda || m === 0xd9) break;
      const len = (b[o + 2] << 8) | b[o + 3];
      if (m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) return tiffTags(b, o + 10);
      o += 2 + len;
    }
    return null;
  }

  function exifOf(b, isRaw) {
    if (!isRaw) return jpegExif(b) || {};
    let tags = tiffTags(b, 0);
    if (!tags || !(0x9003 in tags)) { // CR3 (ISO BMFF): CMT1 = IFD0, CMT2 = Exif IFD
      const c1 = findBytes(b, ascii("CMT1"), 0, 1 << 20), c2 = findBytes(b, ascii("CMT2"), 0, 1 << 20);
      if (c1 > 0 || c2 > 0) tags = Object.assign({}, c1 > 0 ? tiffTags(b, c1 + 4) : {}, c2 > 0 ? tiffTags(b, c2 + 4) : {});
    }
    if (!tags || !(0x9003 in tags)) { // RAF and others: the embedded JPEG carries the EXIF
      const j = findBytes(b, [0xff, 0xd8, 0xff, 0xe1], 0, 1 << 20);
      if (j >= 0) tags = Object.assign({}, tags || {}, jpegExif(b.subarray(j)) || {});
    }
    return tags || {};
  }

  function parseTime(dto, subsec) {
    if (!dto || typeof dto !== "string" || dto.startsWith("0000")) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dto);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000; // camera-local time, compared within a shoot
    const digits = String(subsec || "").replace(/\D/g, "");
    return { t: t + (digits ? parseFloat("0." + digits) : 0),
      text: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` + (digits ? "." + (digits + "000").slice(0, 3) : ".000") };
  }

  /** the same meta dict as the desktop tool (loader.normalise_meta) */
  WC.readMeta = function (bytes, isRaw, lastModified) {
    const t = exifOf(bytes, isRaw);
    const tm = parseTime(t[0x9003] || t[0x9004] || t[0x0132], t[0x9291] || t[0x9290]);
    const camera = [t[0x0110], t[0xa431]].filter(Boolean).join(" ");
    const ori = Number(t[0x0112]) || 1;
    return {
      time: tm ? tm.t : lastModified / 1000, time_source: tm ? "exif" : "mtime", time_text: tm ? tm.text : "",
      exposure_time: t[0x829a] ?? null, fnumber: t[0x829d] ?? null, iso: t[0x8827] ?? null,
      ec: t[0x9204] || 0.0, orientation: ori >= 1 && ori <= 8 ? ori : 1, camera,
      flash: t[0x9209] ?? null, focal: t[0x920a] ?? null,
    };
  };

  // ------------------------------------------------------------------ JPEG structure
  const isSOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

  /** Walk one JPEG starting at `s` (FFD8). -> {end, w, h} or null. Handles progressive (several SOS). */
  function walkJpeg(b, s) {
    let o = s + 2, w = 0, h = 0;
    while (o + 2 <= b.length) {
      if (b[o] !== 0xff) return null;
      let m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd9) return w ? { end: o + 2, w, h } : null;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (o + 4 > b.length) return null;
      const len = (b[o + 2] << 8) | b[o + 3];
      if (len < 2) return null;
      if (isSOF(m) && o + 9 <= b.length) { h = (b[o + 5] << 8) | b[o + 6]; w = (b[o + 7] << 8) | b[o + 8]; }
      o += 2 + len;
      if (m === 0xda) { // entropy-coded data until the next real marker
        while (o + 1 < b.length) {
          if (b[o] === 0xff) {
            const n = b[o + 1];
            if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
          }
          o++;
        }
      }
    }
    return null;
  }

  WC.jpegSize = function (b) { const r = walkJpeg(b, 0); return r ? { w: r.w, h: r.h } : null; };

  /** the largest complete JPEG embedded in a RAW (its full-size preview) */
  WC.largestEmbeddedJpeg = function (b) {
    let best = null;
    for (let i = findBytes(b, [0xff, 0xd8, 0xff]); i >= 0; i = findBytes(b, [0xff, 0xd8, 0xff], i + 3)) {
      const r = walkJpeg(b, i);
      if (r && r.w * r.h > (best ? best.w * best.h : 0)) best = { start: i, end: r.end, w: r.w, h: r.h };
      if (r && r.w * r.h >= 4e6) i = r.end - 3; // skip over a big image's data
    }
    return best ? { bytes: b.subarray(best.start, best.end), w: best.w, h: best.h } : null;
  };

  WC.jpegOrientation = function (b) { const t = jpegExif(b); return t && t[0x0112] ? Number(t[0x0112]) : 1; };

  // ------------------------------------------------------------------ XMP inside a JPEG
  const XMP_SIG = "http://ns.adobe.com/xap/1.0/\u0000";
  const XMP_SIG_B = ascii(XMP_SIG);
  const enc = new TextEncoder(), dec = new TextDecoder();

  /** segments before the image data: [{marker, start, end}] and the offset where SOS starts */
  function headerSegments(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG");
    const segs = [];
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) throw new Error("broken JPEG header");
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xda || m === 0xd9) return { segs, sos: o };
      const len = (b[o + 2] << 8) | b[o + 3];
      segs.push({ marker: m, start: o, end: o + 2 + len });
      o += 2 + len;
    }
    throw new Error("no image data in JPEG");
  }

  function isXmpSeg(b, s) {
    if (s.marker !== 0xe1) return false;
    for (let j = 0; j < XMP_SIG_B.length; j++) if (b[s.start + 4 + j] !== XMP_SIG_B[j]) return false;
    return true;
  }

  /** existing standard XMP packet of a JPEG (string) or null */
  WC.jpegXmp = function (b) {
    const { segs } = headerSegments(b);
    const s = segs.find((x) => isXmpSeg(b, x));
    return s ? dec.decode(b.subarray(s.start + 4 + XMP_SIG_B.length, s.end)) : null;
  };

  /** new JPEG bytes with `xmp` as its XMP block. The image data (SOS..end) is copied byte for byte. */
  WC.jpegWithXmp = function (b, xmp) {
    const { segs, sos } = headerSegments(b);
    const payload = enc.encode(xmp);
    const segLen = 2 + XMP_SIG_B.length + payload.length;
    if (segLen > 0xffff) throw new Error("XMP too large for one JPEG segment");
    const seg = new Uint8Array(2 + segLen);
    seg[0] = 0xff; seg[1] = 0xe1; seg[2] = segLen >> 8; seg[3] = segLen & 0xff;
    seg.set(XMP_SIG_B, 4); seg.set(payload, 4 + XMP_SIG_B.length);
    const old = segs.find((x) => isXmpSeg(b, x));
    let cutStart, cutEnd;
    if (old) { cutStart = old.start; cutEnd = old.end; } else {
      // after APP0 (JFIF) and the Exif APP1, where Adobe puts it
      let at = 2;
      for (const s of segs) { if (s.marker === 0xe0 || s.marker === 0xe1) at = s.end; else break; }
      cutStart = cutEnd = at;
    }
    const out = new Uint8Array(b.length - (cutEnd - cutStart) + seg.length);
    out.set(b.subarray(0, cutStart), 0);
    out.set(seg, cutStart);
    out.set(b.subarray(cutEnd), cutStart + seg.length);
    // safety: the image data must be identical
    const n = headerSegments(out);
    const a1 = b.subarray(sos), a2 = out.subarray(n.sos);
    if (a1.length !== a2.length) throw new Error("image data changed - not written");
    for (let i = 0; i < a1.length; i += 1) if (a1[i] !== a2[i]) throw new Error("image data changed - not written");
    return out;
  };

  // ------------------------------------------------------------------ XMP documents
  const NS = {
    x: "adobe:ns:meta/", rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", xmp: "http://ns.adobe.com/xap/1.0/",
    dc: "http://purl.org/dc/elements/1.1/", lr: "http://ns.adobe.com/lightroom/1.0/",
  };
  WC.XMP_MARKER = 'x:xmptk="wedding-cull';
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const leaf = (k) => k.split("|").pop();

  /** a fresh XMP packet (same layout as the desktop tool's sidecars) */
  WC.renderXmp = function (p) {
    const labelAttr = p.label ? `\n    xmp:Label="${esc(p.label)}"` : "";
    let subjects = "";
    if (p.keywords.length) {
      const flat = [...new Set(p.keywords.flatMap((k) => k.split("|")))].sort();
      const hier = [...new Set(p.keywords.flatMap((k) => k.split("|").map((_, i, a) => a.slice(0, i + 1).join("|"))))].sort();
      subjects = "   <dc:subject>\n    <rdf:Bag>\n" + flat.map((k) => `     <rdf:li>${esc(k)}</rdf:li>\n`).join("") +
        "    </rdf:Bag>\n   </dc:subject>\n   <lr:hierarchicalSubject>\n    <rdf:Bag>\n" +
        hier.map((k) => `     <rdf:li>${esc(k)}</rdf:li>\n`).join("") + "    </rdf:Bag>\n   </lr:hierarchicalSubject>\n";
    }
    return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="wedding-cull web">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
    xmp:Rating="${p.rating}"${labelAttr}>
${subjects}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
  };

  /** true when a sidecar is one this tool wrote (safe to overwrite); Camera Raw settings make it not ours */
  WC.isOwnXmp = (text) => text.slice(0, 600).includes(WC.XMP_MARKER) && !text.includes("crs:");

  /**
   * Change only rating, label and our keywords in an existing XMP packet (Camera Raw edits, other keywords and
   * everything else stay). Needs DOMParser/XMLSerializer (the page). Mirrors the desktop's exiftool merge.
   */
  WC.mergeXmp = function (text, p, managed, ourLabels) {
    // writers pad packets with NULs / whitespace after <?xpacket end?>: not part of the XML
    let clean = text.replace(/^\uFEFF/, "");
    const endPi = clean.search(/<\?xpacket\s+end=["'][rw]["']\s*\?>/);
    if (endPi >= 0) clean = clean.slice(0, clean.indexOf("?>", endPi) + 2);
    clean = clean.replace(/[\u0000\s]+$/, "");
    const doc = new DOMParser().parseFromString(clean, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("existing XMP could not be read");
    let rdf = doc.getElementsByTagNameNS(NS.rdf, "RDF")[0];
    if (!rdf) throw new Error("existing XMP has no rdf:RDF");
    const descs = Array.from(doc.getElementsByTagNameNS(NS.rdf, "Description"));
    let desc = descs[0];
    if (!desc) {
      desc = doc.createElementNS(NS.rdf, "rdf:Description");
      desc.setAttributeNS(NS.rdf, "rdf:about", "");
      rdf.appendChild(desc);
    }
    const bind = (prefix, ns) => {
      if (desc.lookupNamespaceURI(prefix) !== ns) desc.setAttributeNS("http://www.w3.org/2000/xmlns/", `xmlns:${prefix}`, ns);
    };
    const simple = (ns, prefix, local) => ({
      get() {
        for (const d of descs) { if (d.hasAttributeNS(ns, local)) return d.getAttributeNS(ns, local); }
        const el = doc.getElementsByTagNameNS(ns, local)[0];
        return el ? el.textContent : null;
      },
      set(v) {
        for (const d of descs) d.removeAttributeNS(ns, local);
        for (const el of Array.from(doc.getElementsByTagNameNS(ns, local))) el.parentNode.removeChild(el);
        if (v !== null) { bind(prefix, ns); desc.setAttributeNS(ns, `${prefix}:${local}`, String(v)); }
      },
    });
    simple(NS.xmp, "xmp", "Rating").set(p.rating);
    const lab = simple(NS.xmp, "xmp", "Label");
    if (p.label) lab.set(p.label); else if (ourLabels.includes(lab.get())) lab.set(null);

    const bag = (ns, prefix, local, remove, add) => {
      let el = doc.getElementsByTagNameNS(ns, local)[0];
      if (!el) {
        if (!add.length) return;
        bind(prefix, ns);
        el = doc.createElementNS(ns, `${prefix}:${local}`);
        desc.appendChild(el);
      }
      let list = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.namespaceURI === NS.rdf);
      if (!list) { list = doc.createElementNS(NS.rdf, "rdf:Bag"); el.appendChild(list); }
      const items = Array.from(list.childNodes).filter((n) => n.nodeType === 1);
      const have = new Set();
      for (const li of items) {
        if (remove.has(li.textContent)) list.removeChild(li); else have.add(li.textContent);
      }
      for (const v of add) if (!have.has(v)) {
        const li = doc.createElementNS(NS.rdf, "rdf:li");
        li.textContent = v;
        list.appendChild(li);
        have.add(v);
      }
    };
    const roots = [...new Set(p.keywords.filter((k) => k.includes("|")).map((k) => k.split("|")[0]))].sort();
    bag(NS.dc, "dc", "subject", new Set(managed.map(leaf)), [...p.keywords.map(leaf), ...roots]);
    bag(NS.lr, "lr", "hierarchicalSubject", new Set(managed), p.keywords);
    let out = new XMLSerializer().serializeToString(doc);
    if (!out.startsWith("<?xpacket")) out = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${out}\n<?xpacket end="w"?>\n`;
    return out;
  };

  // ------------------------------------------------------------------ ZIP (store only)
  let CRC = null;
  function crc32(b) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  /** files: [{name, data: string|Uint8Array}] -> Blob (application/zip), UTF-8 names */
  WC.zip = function (files) {
    const parts = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xff, (v >> 8) & 0xff], u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    for (const f of files) {
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0),
        ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += head.length + name.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  };

  // ------------------------------------------------------------------ Adobe apps
  /** label name each app uses for yellow by default */
  WC.ADOBE = {
    bridge: { name: "Adobe Bridge", label: "Second" },
    lightroom: { name: "Lightroom Classic", label: "Yellow" },
  };

  /** ExtendScript for Photoshop: opens the listed photos (paths relative to the event folder). Saved in
      <event>/_cull/, it finds the event folder by itself; anywhere else it asks for the folder. */
  WC.photoshopScript = function (title, rels) {
    const list = rels.map((r) => JSON.stringify(r)).join(",\n  ");
    return `// ${title} - made by Wedding Cull. In Photoshop: File > Scripts > Browse... and pick this file.
#target photoshop
(function () {
  var files = [
  ${list}
  ];
  var here = File($.fileName).parent;
  var base = here.name === "_cull" ? here.parent : Folder.selectDialog("Choose the event folder these photos are in");
  if (!base) return;
  if (files.length > 30 && !confirm("Open " + files.length + " photos in Photoshop?")) return;
  var missing = 0;
  for (var i = 0; i < files.length; i++) {
    var f = new File(base.fsName + "/" + files[i]);
    if (f.exists) { app.open(f); } else { missing++; }
  }
  if (missing) alert(missing + " of " + files.length + " photos were not found in " + base.fsName);
})();
`;
  };

  if (typeof module === "object" && module && module.exports && typeof window === "undefined" &&
      typeof importScripts === "undefined") module.exports = WC;
})(typeof self !== "undefined" ? self : globalThis);
