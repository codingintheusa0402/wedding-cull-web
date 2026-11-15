/* Wedding Cull web app (page side): folder access, worker pool, cache, review UI, saving for Lightroom /
   Bridge / Photoshop. Everything happens in this browser; nothing is sent anywhere. */
(function () {
  "use strict";
  const WC = window.WC;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

  const S = {
    root: null,            // FileSystemDirectoryHandle (Chrome / Edge) or null (read-only fallback)
    rootName: "",
    entries: [],           // {id, name, rel, handle?, parent?, file?, isRaw, sidecar?}
    byId: new Map(),
    companions: new Map(),
    feats: new Map(),      // id -> feature dict
    thumbs: new Map(),     // id -> object URL
    results: [], resById: new Map(),
    overrides: new Map(),  // file name -> keep | reject | check
    strictness: "normal", app: "lightroom", recursive: false, embed: true,
    view: "overview", faceError: null, stats: null, sel: new Set(),
  };
  window.WCApp = { S, WC };

  // ------------------------------------------------------------------ settings remembered in this browser
  const store = {
    get(k, d) { try { const v = localStorage.getItem("wc." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("wc." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  S.strictness = store.get("strictness", "normal");
  S.app = store.get("app", "lightroom");

  // ------------------------------------------------------------------ IndexedDB cache (features + thumbnails)
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res) => {
        let req;
        try { req = indexedDB.open("wedding-cull", 1); } catch { res(null); return; }
        req.onupgradeneeded = () => { req.result.createObjectStore("feat"); req.result.createObjectStore("decisions"); };
        req.onsuccess = () => { this.db = req.result; res(this.db); };
        req.onerror = () => res(null);
      });
    },
    async op(storeName, mode, fn) {
      const db = await this.open();
      if (!db) return undefined;
      return new Promise((res) => {
        try {
          const tx = db.transaction(storeName, mode);
          const r = fn(tx.objectStore(storeName));
          tx.oncomplete = () => res(r && r.result);
          tx.onerror = tx.onabort = () => res(undefined);
        } catch { res(undefined); }
      });
    },
    get(s, k) { return this.op(s, "readonly", (o) => o.get(k)); },
    put(s, k, v) { return this.op(s, "readwrite", (o) => o.put(v, k)); },
  };

  // ------------------------------------------------------------------ worker pool
  class Pool {
    constructor(n) {
      this.n = n; this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this.seq = 0;
      for (let i = 0; i < n; i++) {
        const w = new Worker("worker.js");
        w.onmessage = (e) => this.done(w, e.data);
        w.onerror = (e) => { console.error("worker error", e.message); };
        this.workers.push(w);
      }
    }
    async ready() {
      const outs = await Promise.all(this.workers.map((w) => new Promise((res) => {
        const seq = ++this.seq; this.pending.set(seq, { res, w });
        w.postMessage({ type: "ping", seq });
      })));
      this.idle = this.workers.slice();
      return outs;
    }
    done(w, msg) {
      if (msg.type === "ready") { const p = [...this.pending.entries()].find(([, v]) => v.w === w); if (p) { this.pending.delete(p[0]); p[1].res(msg); } return; }
      const p = this.pending.get(msg.seq);
      if (p) { this.pending.delete(msg.seq); p.res(msg); }
      this.idle.push(w); this.pump();
    }
    run(job, urgent = false) {
      return new Promise((res) => { const item = { job, res }; if (urgent) this.queue.unshift(item); else this.queue.push(item); this.pump(); });
    }
    pump() {
      while (this.idle.length && this.queue.length) {
        const w = this.idle.shift(), { job, res } = this.queue.shift();
        const seq = ++this.seq; this.pending.set(seq, { res, w });
        w.postMessage(Object.assign({ seq }, job));
      }
    }
    terminate() { this.workers.forEach((w) => w.terminate()); }
  }
  let pool = null;
  const cores = () => Math.max(1, Math.min(navigator.deviceMemory && navigator.deviceMemory < 8 ? 3 : 6, (navigator.hardwareConcurrency || 4) - 1));

  // ------------------------------------------------------------------ start screen
  const canWrite = "showDirectoryPicker" in window;
  function initStart() {
    const sup = $("support");
    sup.innerHTML = canWrite
      ? "Your browser can save ratings straight into the folder. Choosing a folder asks for permission; nothing is uploaded."
      : "This browser can read folders but not write to them: you get the ratings as a ZIP of XMP sidecars, which Lightroom and Bridge read for RAW files. For JPEGs and one-click saving use <b>Chrome</b> or <b>Edge</b> (Mac and Windows).";
    if (!canWrite) sup.classList.add("warn");
    seg($("strictStart"), S.strictness, (v) => { S.strictness = v; store.set("strictness", v); });
    seg($("appStart"), S.app, (v) => { S.app = v; store.set("app", v); });
    $("recursive").onchange = (e) => { S.recursive = e.target.checked; };
    $("pick").onclick = pickFolder;
    const drop = $("drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", onDrop);
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter") pickFolder(); });
  }

  function seg(el, value, onChange) {
    for (const b of el.querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.v === value);
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(b.dataset.v === value));
      b.onclick = () => {
        for (const x of el.querySelectorAll("button")) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); }
        onChange(b.dataset.v);
      };
    }
  }

  let fallbackInput = null;
  async function pickFolder() {
    if (canWrite) {
      try {
        const h = await window.showDirectoryPicker({ id: "wedding-cull", mode: "read" });
        await openHandle(h);
      } catch (e) { if (e.name !== "AbortError") toast(`Could not open the folder: ${e.message}`); }
      return;
    }
    if (!fallbackInput) {
      fallbackInput = document.createElement("input");
      fallbackInput.type = "file"; fallbackInput.webkitdirectory = true; fallbackInput.multiple = true; fallbackInput.hidden = true;
      fallbackInput.id = "folderInput";
      fallbackInput.onchange = () => openFileList(Array.from(fallbackInput.files));
      document.body.appendChild(fallbackInput);
    }
    fallbackInput.click();
  }

  async function onDrop(e) {
    e.preventDefault(); $("drop").classList.remove("over");
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (!item) return;
    if (item.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === "directory") { await openHandle(h); return; }
    }
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry && entry.isDirectory) { openFileList(await filesFromEntry(entry)); return; }
    toast("Drop a folder, not single files.");
  }

  function filesFromEntry(dirEntry) {
    const out = [];
    const walk = (dir, prefix) => new Promise((res) => {
      const reader = dir.createReader(), all = [];
      const more = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const en of all) {
            if (en.name.startsWith(".")) continue;
            if (en.isDirectory) { if (S.recursive && !WC.SKIP_DIRS.has(en.name)) await walk(en, prefix + en.name + "/"); }
            else await new Promise((r) => en.file((f) => { Object.defineProperty(f, "relPath", { value: prefix + en.name }); out.push(f); r(); }, r));
          }
          res();
        } else { all.push(...batch); more(); }
      }, () => res());
      more();
    });
    S.rootName = dirEntry.name;
    return walk(dirEntry, "").then(() => out);
  }

  // ------------------------------------------------------------------ listing the folder
  async function openHandle(h) {
    S.root = h; S.rootName = h.name;
    const list = [];
    const walk = async (dir, prefix) => {
      const names = new Map();
      const kids = [];
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith(".")) continue;
        kids.push([name, handle]);
        if (handle.kind === "file") names.set(name.toLowerCase(), name);
      }
      for (const [name, handle] of kids) {
        if (handle.kind === "directory") {
          if (S.recursive && !WC.SKIP_DIRS.has(name)) await walk(handle, prefix + name + "/");
          continue;
        }
        const ext = WC.ext(name);
        if (!WC.RAW_EXT.has(ext) && !WC.JPEG_EXT.has(ext)) continue;
        const sc = names.get((WC.stem(name) + ".xmp").toLowerCase());
        list.push({ name, rel: prefix + name, handle, parent: dir, isRaw: WC.RAW_EXT.has(ext), sidecar: sc || null });
      }
    };
    await walk(h, "");
    await start(list);
  }

  function openFileList(files) {
    S.root = null;
    const list = [];
    for (const f of files) {
      let rel = f.relPath || f.webkitRelativePath || f.name;
      if (!f.relPath && f.webkitRelativePath) { const i = rel.indexOf("/"); if (!S.rootName) S.rootName = rel.slice(0, i); rel = rel.slice(i + 1); }
      const parts = rel.split("/");
      if (parts.some((p) => p.startsWith("."))) continue;
      if (parts.length > 1 && (!S.recursive || parts.slice(0, -1).some((p) => WC.SKIP_DIRS.has(p)))) continue;
      const ext = WC.ext(f.name);
      if (!WC.RAW_EXT.has(ext) && !WC.JPEG_EXT.has(ext)) continue;
      list.push({ name: f.name, rel, file: f, isRaw: WC.RAW_EXT.has(ext), sidecar: null });
    }
    start(list);
  }

  async function sha12(s) {
    const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ------------------------------------------------------------------ analysis
  async function start(list) {
    if (!list.length) { toast("No JPEG or RAW photos in that folder" + (S.recursive ? "." : " (turn on Include subfolders?).")); return; }
    const { photos, companions } = WC.pairPhotos(list);
    S.entries = photos; S.companions = companions; S.byId.clear(); S.feats.clear();
    for (const u of S.thumbs.values()) URL.revokeObjectURL(u);
    S.thumbs.clear();
    for (const e of photos) { e.id = await sha12(S.rootName + "/" + e.rel); S.byId.set(e.id, e); }
    const saved = await DB.get("decisions", S.rootName);
    S.overrides = new Map(saved && saved.overrides ? saved.overrides : []);
    show("progress");
    $("progTitle").textContent = `Analysing ${S.rootName}`;
    $("progM").textContent = photos.length.toLocaleString();
    $("stream").innerHTML = "";
    const t0 = performance.now();
    let done = 0, fromCache = 0, errors = 0, tFirst = 0;
    const cfg = WC.config(S.strictness);
    const tick = () => {
      const el = (performance.now() - t0) / 1000;
      $("progN").textContent = done.toLocaleString();
      $("progBar").style.width = `${(100 * done) / photos.length}%`;
      $("progElapsed").textContent = fmtTime(el);
      // speed from the first finished photo on (engine start-up is not part of it)
      const fresh = done - fromCache - 1;
      const rate = fresh >= 3 && tFirst ? fresh / ((performance.now() - tFirst) / 1000) : 0;
      $("progRate").textContent = rate ? rate.toFixed(1) : "-";
      $("progLeft").textContent = rate ? fmtTime((photos.length - done) / rate) : "-";
    };
    const timer = setInterval(tick, 250);
    const stream = (id, f) => {
      const url = S.thumbs.get(id);
      if (!url) return;
      const st = f && !f.error ? WC.summarise(WC.evaluate(f, cfg.thresholds))[0] : "";
      const img = new Image(); img.src = url; img.className = st; img.alt = "";
      const s = $("stream"); s.prepend(img);
      while (s.children.length > 60) s.lastChild.remove();
    };
    // cache first
    const todo = [];
    const keyOf = async (e) => { const file = e.file || await e.handle.getFile(); e.size = file.size; e.mtime = file.lastModified; e._file = file;
      return `${WC.FEATURE_VERSION}|${S.rootName}/${e.rel}|${file.size}|${file.lastModified}`; };
    for (const e of photos) {
      e.key = await keyOf(e);
      const c = await DB.get("feat", e.key);
      if (c && c.f) {
        S.feats.set(e.id, Object.assign(c.f, { id: e.id, path: e.rel, name: e.name }));
        if (c.thumb) S.thumbs.set(e.id, URL.createObjectURL(c.thumb));
        done++; fromCache++;
      } else todo.push(e);
    }
    tick();
    if (todo.length) {
      if (!pool) {
        $("progNote").textContent = "Loading the analysis engine (OpenCV + MediaPipe, once)…";
        pool = new Pool(cores());
        const outs = await pool.ready();
        S.faceError = (outs.find((o) => o.faceError) || {}).faceError || null;
        $("progNote").textContent = "Measuring sharpness, faces, eyes and exposure on this computer. Nothing is uploaded.";
      }
      $("progWorkers").textContent = pool.n;
      await Promise.all(todo.map((e) => pool.run({ type: "analyse", id: e.id, file: e._file, isRaw: e.isRaw, thumbPx: 480 }).then(async (msg) => {
        let f;
        if (msg.error) { f = { error: msg.error }; errors++; } else {
          f = msg.f;
          if (msg.thumb) S.thumbs.set(e.id, URL.createObjectURL(msg.thumb));
          DB.put("feat", e.key, { f, thumb: msg.thumb || null });
        }
        S.feats.set(e.id, Object.assign(f, { id: e.id, path: e.rel, name: e.name }));
        done++;
        if (!tFirst) tFirst = performance.now();
        stream(e.id, f);
      })));
    } else $("progWorkers").textContent = "-";
    for (const e of photos) delete e._file;
    clearInterval(timer); tick();
    S.stats = { photos: photos.length, analysed: todo.length, cached: fromCache, errors, seconds: (performance.now() - t0) / 1000 };
    decide();
    S.view = "overview";
    show("review");
    render();
  }

  function cfgNow() {
    return WC.config(S.strictness, { output: { check_label: S.app === "lightroom" ? WC.ADOBE.lightroom.label : WC.ADOBE.bridge.label } });
  }
  function decide() {
    const feats = S.entries.map((e) => S.feats.get(e.id)).filter(Boolean);
    S.results = WC.decideAll(feats, cfgNow(), S.overrides);
    S.resById = new Map(S.results.map((r) => [r.id, r]));
  }
  function saveDecisions() { DB.put("decisions", S.rootName, { overrides: [...S.overrides] }); }

  // ------------------------------------------------------------------ review UI
  function show(id) { for (const s of ["start", "progress", "review"]) $(s).hidden = s !== id; document.body.classList.toggle("reviewing", id === "review"); window.scrollTo(0, 0); renderBar(id); }

  function renderBar(screen) {
    const mid = $("barMid");
    if (screen !== "review") { mid.innerHTML = ""; return; }
    mid.innerHTML = `<span class="fname" title="${esc(S.rootName)}">${esc(S.rootName)}</span>
      <span class="seg" id="strictBar"><button data-v="gentle">Gentle</button><button data-v="normal">Normal</button><button data-v="strict">Strict</button></span>
      <span class="seg" id="appBar"><button data-v="lightroom">Lightroom</button><button data-v="bridge">Bridge + PS</button></span>
      <span class="topctl">
        ${S.root ? '<button class="btn primary" id="saveBtn">Save to folder</button>' : ""}
        <button class="btn${S.root ? "" : " primary"}" id="zipBtn">Download XMP (ZIP)</button>
        <button class="linkbtn" id="newBtn" title="Choose another folder">New folder</button>
      </span>`;
    seg($("strictBar"), S.strictness, (v) => { S.strictness = v; store.set("strictness", v); decide(); render(); toast(`Strictness: ${v}`); });
    seg($("appBar"), S.app, (v) => { S.app = v; store.set("app", v); decide(); render(); });
    if (S.root) $("saveBtn").onclick = saveToFolder;
    $("zipBtn").onclick = downloadZip;
    $("newBtn").onclick = () => { show("start"); };
  }

  const groups = () => {
    const g = { reject: new Map(), check: new Map(), bursts: new Map(), kept: [], errors: [] };
    for (const k of WC.CHECKS) { g.reject.set(k, []); g.check.set(k, []); }
    for (const r of S.results) {
      if (r.status === "error") { g.errors.push(r); continue; }
      const bucket = r.status === "reject" || r.status === "check" ? g[r.status] : null;
      const why = r.primary || r.reasons[0] || (r.auto_status !== "ok" ? "blur" : "");
      if (bucket) (bucket.get(why) || bucket.set(why, []).get(why)).push(r);
      else g.kept.push(r);
      if (r.burst_size > 1) { if (!g.bursts.has(r.burst)) g.bursts.set(r.burst, []); g.bursts.get(r.burst).push(r); }
    }
    return g;
  };
  const count = (m) => [...m.values()].reduce((a, l) => a + l.length, 0);

  function render() {
    const g = renderSide();
    const nRej = count(g.reject), nChk = count(g.check);
    renderContent(g, nRej, nChk);
  }

  function renderSide() {
    const g = groups();
    const nRej = count(g.reject), nChk = count(g.check);
    const side = $("side");
    const link = (v, label, n, dot, sub) => `<a data-v="${v}" class="${S.view === v ? "on" : ""}${sub ? " sub" : ""}"><em>${dot ? `<i class="dot ${dot}"></i>` : ""}${esc(label)}</em>${n === null ? "" : `<span>${n.toLocaleString()}</span>`}</a>`;
    let h = link("overview", "Overview", S.results.length);
    h += `<h4>Flagged</h4>` + link("reject", "Rejects", nRej, "reject");
    for (const [k, l] of g.reject) if (l.length) h += link(`reject:${k}`, WC.LABELS[k], l.length, null, true);
    h += link("check", "To check", nChk, "check");
    for (const [k, l] of g.check) if (l.length) h += link(`check:${k}`, WC.LABELS[k], l.length, null, true);
    h += `<h4>Everything else</h4>` + link("bursts", "Bursts", g.bursts.size, "best") + link("kept", "Kept", g.kept.length, "ok");
    if (g.errors.length) h += link("errors", "Could not read", g.errors.length);
    h += `<h4>Open in</h4>` + link("apps", "Lightroom · Bridge · Photoshop", null);
    side.innerHTML = h;
    for (const a of side.querySelectorAll("a")) a.onclick = () => { S.view = a.dataset.v; S.sel.clear(); render(); window.scrollTo(0, 0); };
    return g;
  }

  function renderContent(g, nRej, nChk) {
    const c = $("content");
    const v = S.view;
    if (v === "overview") c.innerHTML = overviewHtml(g, nRej, nChk);
    else if (v === "apps") c.innerHTML = appsHtml();
    else if (v === "bursts") c.innerHTML = burstsHtml(g);
    else if (v === "kept") c.innerHTML = section("Kept", g.kept, "Photos with no problem found. Best frames of bursts are starred.");
    else if (v === "errors") c.innerHTML = section("Could not read", g.errors, "These files could not be decoded (damaged, or a RAW without an embedded preview).");
    else {
      const [st, k] = v.split(":");
      const m = g[st];
      const title = st === "reject" ? "Rejects" : "To check";
      if (k) c.innerHTML = section(`${title} · ${WC.LABELS[k]}`, m.get(k) || []);
      else {
        let x = `<div class="sec"><h2>${title}</h2><span>${(st === "reject" ? nRej : nChk).toLocaleString()}</span></div>
          <p class="hint">${st === "reject" ? "Marked Reject in Lightroom / Bridge." : `Get the yellow label (“${esc(cfgNow().output.check_label)}”).`} Press <b>K</b> keep · <b>R</b> reject · <b>C</b> check · <b>U</b> undo · <b>Enter</b> full size.</p>`;
        for (const [kk, l] of m) if (l.length) x += section(WC.LABELS[kk], l, null, true);
        if (!(st === "reject" ? nRej : nChk)) x += `<p class="empty">Nothing here.</p>`;
        c.innerHTML = x;
      }
    }
    wireCards(c);
    wireApps(c);
  }

  function overviewHtml(g, nRej, nChk) {
    const st = S.stats || {};
    const alt = S.results.filter((r) => r.role === "alternate").length;
    const speed = st.analysed ? `${plural(st.analysed, "photo")} analysed in ${fmtTime(st.seconds)}${st.cached ? `, ${st.cached.toLocaleString()} from the last run` : ""}` : `${plural(st.cached || 0, "photo")} from the last run`;
    let h = `<div class="sec"><h2>${esc(S.rootName)}</h2><span>${speed} · strictness ${S.strictness}</span></div>
      <div class="summary">
        <div class="tile"><b>${S.results.length.toLocaleString()}</b><span>photos</span></div>
        <div class="tile reject"><b>${nRej.toLocaleString()}</b><span>rejects</span></div>
        <div class="tile check"><b>${nChk.toLocaleString()}</b><span>to check</span></div>
        <div class="tile best"><b>${g.bursts.size.toLocaleString()}</b><span>bursts · ${alt.toLocaleString()} alternates</span></div>
        <div class="tile"><b>${(S.results.length - nRej).toLocaleString()}</b><span>keepers</span></div>
      </div>`;
    if (S.faceError) h += `<p class="hint">⚠️ Face and closed-eye checks are off in this browser (no WebGL): ${esc(S.faceError)}. Blur, exposure and bursts still work.</p>`;
    const rows = WC.CHECKS.map((k) => `<tr><td><i class="dot reject"></i>${esc(WC.LABELS[k])}</td><td>${(g.reject.get(k) || []).length}</td><td>${(g.check.get(k) || []).length}</td></tr>`).join("");
    h += `<div class="apps" style="margin-bottom:18px"><div class="app"><h3>Flagged by reason</h3>
      <table style="width:100%;font-size:14px;border-collapse:collapse;margin-top:6px"><tr style="color:var(--muted);text-align:left"><th></th><th>reject</th><th>check</th></tr>${rows}</table></div>
      <div class="app"><h3>Next</h3><ol><li>Look through <b>Rejects</b> and <b>To check</b>; fix any wrong call with K / R / C.</li>
      <li>${S.root ? "<b>Save to folder</b> writes ratings, labels and keywords (XMP)." : "<b>Download XMP (ZIP)</b> and unzip it into the event folder."}</li>
      <li>Open the folder in <b>${S.app === "lightroom" ? "Lightroom Classic" : "Bridge / Photoshop"}</b> (steps under <a href="#" data-go="apps">Open in</a>).</li></ol></div></div>`;
    const preview = S.results.filter((r) => r.status === "reject" || r.status === "check").slice(0, 24);
    if (preview.length) h += section("Flagged photos", preview, "The first flagged photos. All of them are under Rejects and To check.");
    return h;
  }

  function section(title, list, hint, sub) {
    if (!list.length) return `<div class="sec"><h2>${esc(title)}</h2></div><p class="empty">Nothing here.</p>`;
    return `<div class="sec"><h${sub ? 3 : 2} style="${sub ? "font:600 18px var(--serif);margin:0" : ""}">${esc(title)}</h${sub ? 3 : 2}><span>${list.length.toLocaleString()}</span></div>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}<div class="grid">${list.map(cardHtml).join("")}</div>`;
  }

  function cardHtml(r) {
    const url = S.thumbs.get(r.id) || "";
    const why = r.status === "error" ? r.error : (r.primary && r.verdicts[r.primary][2]) || (r.reasons || []).map((k) => r.verdicts[k][2]).filter(Boolean)[0] || (r.role === "best" ? "Best frame of its burst" : r.role === "alternate" ? "Alternate of a burst" : "No problem found");
    const stars = r.status !== "reject" && (r.role === "best" || r.role === "single") ? "★★★" : "";
    const pill = r.status === "reject" ? "Reject" : r.status === "check" ? "Check" : r.status === "ok" ? "" : "";
    const dec = r.override;
    return `<div class="card${r.status === "reject" ? " dim" : ""}${r.role === "best" ? " best" : ""}${S.sel.has(r.id) ? " sel" : ""}" tabindex="0" data-id="${r.id}">
      <div class="im">${url ? `<img src="${url}" alt="${esc(r.name)}" loading="lazy">` : ""}${pill ? `<span class="pill ${r.status}">${pill}</span>` : ""}${stars ? `<span class="star">${stars}</span>` : ""}${dec ? `<span class="ov">you: ${dec}</span>` : ""}</div>
      <div class="meta"><div class="nm" title="${esc(r.name)}">${esc(r.name)}</div><div class="why">${esc(why)}</div>
      ${r.status === "error" ? "" : `<div class="acts"><button data-d="keep" class="${dec === "keep" ? "on" : ""}" title="Keep (K)">Keep</button><button data-d="reject" class="${dec === "reject" ? "on" : ""}" title="Reject (R)">Reject</button><button data-d="check" class="${dec === "check" ? "on" : ""}" title="Check (C)">Check</button></div>`}</div></div>`;
  }

  function burstsHtml(g) {
    if (!g.bursts.size) return `<div class="sec"><h2>Bursts</h2></div><p class="empty">No bursts found (photos taken within a couple of seconds that look alike).</p>`;
    let h = `<div class="sec"><h2>Bursts</h2><span>${g.bursts.size.toLocaleString()}</span></div><p class="hint">Frames taken seconds apart that look alike. The best one (sharpest, eyes open, best exposure) is outlined and gets ★★★; the others are alternates.</p>`;
    for (const [b, list] of g.bursts) {
      const best = list.find((r) => r.role === "best");
      h += `<div class="burst"><header><span>Burst ${b} · ${list.length} frames</span><span>best: ${esc(best ? best.name : "-")}</span></header><div class="grid">${list.map(cardHtml).join("")}</div></div>`;
    }
    return h;
  }

  function appsHtml() {
    const lab = cfgNow().output.check_label;
    const saved = S.root ? "Click <b>Save to folder</b> (top right)." : "Click <b>Download XMP (ZIP)</b> and unzip it into the event folder, next to the photos (RAW files only: for JPEGs open Wedding Cull in Chrome or Edge).";
    return `<div class="sec"><h2>Open in Lightroom, Bridge or Photoshop</h2></div>
      <p class="hint">Wedding Cull writes standard XMP metadata: <b>Reject</b> (rating −1) for rejects, the yellow label “${esc(lab)}” for photos to check, ★★★ for the best frame of each burst and for good single shots, and keywords such as <code>Culling|Blur / camera shake</code>. ${S.root ? "Inside JPEGs (image data untouched) and in .xmp sidecars next to RAW files." : "As .xmp sidecars."}</p>
      <div class="apps">
        <div class="app"><h3><span class="badge lr">Lr</span>Lightroom Classic</h3><ol>
          <li>${saved}${S.app !== "lightroom" ? ' Switch the top bar to <b>Lightroom</b> first (yellow label = “Yellow”).' : ""}</li>
          <li><b>File → Import</b> the folder, or if it is already in your catalog: select its photos, <b>Metadata → Read Metadata from Files</b>.</li>
          <li>Filter with the <b>Attribute</b> bar: <b>Rejected</b>, <b>★★★</b>, the <b>yellow</b> label; or the <b>Keyword</b> column “Culling”.</li></ol></div>
        <div class="app"><h3><span class="badge br">Br</span>Adobe Bridge</h3><ol>
          <li>${saved}${S.app !== "bridge" ? ' Switch the top bar to <b>Bridge + PS</b> first (yellow label = “Second”).' : ""}</li>
          <li>Open the folder in Bridge (<b>View → Refresh</b> if it was open).</li>
          <li><b>Filter</b> panel: <b>Ratings → Reject</b>, <b>★★★</b>, <b>Labels → ${esc(lab)}</b>, <b>Keywords → Culling</b>.</li></ol></div>
        <div class="app"><h3><span class="badge ps">Ps</span>Photoshop</h3><ol>
          <li>${S.root ? "<b>Save to folder</b> also writes two scripts into <code>_cull/</code>." : "Download a script below and save it into the event folder's <code>_cull</code> folder (or anywhere: it then asks for the folder)."}</li>
          <li>In Photoshop: <b>File → Scripts → Browse…</b> and pick <code>Open keepers in Photoshop.jsx</code> or <code>Open photos to check in Photoshop.jsx</code>. RAW files open in Camera Raw.</li>
          <li>Or pick photos in Bridge and use <b>File → Open With → Photoshop</b>.</li></ol>
          <div class="topctl"><button class="btn" data-ps="keepers">Keepers script</button><button class="btn" data-ps="check">To-check script</button></div></div>
      </div>
      <p class="hint" style="margin-top:14px">Decisions file for the desktop Wedding Cull: <button class="btn" id="ovBtn">overrides.csv</button> <button class="btn" id="csvBtn">results.csv</button></p>`;
  }

  function wireApps(c) {
    for (const a of c.querySelectorAll("[data-go]")) a.onclick = (e) => { e.preventDefault(); S.view = a.dataset.go; render(); };
    for (const b of c.querySelectorAll("[data-ps]")) b.onclick = () => {
      const s = psScripts()[b.dataset.ps];
      download(new Blob([s.text], { type: "text/plain" }), s.name);
    };
    const ov = c.querySelector("#ovBtn"); if (ov) ov.onclick = () => download(new Blob([WC.overridesCsv(S.overrides)], { type: "text/csv" }), "overrides.csv");
    const cs = c.querySelector("#csvBtn"); if (cs) cs.onclick = () => download(new Blob([WC.csvRows(S.results)], { type: "text/csv" }), "results.csv");
  }

  function relWithCompanion(r) {
    const e = S.byId.get(r.id);
    return e ? e.rel : r.path;
  }
  function psScripts() {
    const ok = S.results.filter((r) => r.status === "ok" && r.role !== "alternate");
    const chk = S.results.filter((r) => r.status === "check");
    return {
      keepers: { name: "Open keepers in Photoshop.jsx", text: WC.photoshopScript(`Keepers of ${S.rootName} (${ok.length})`, ok.map(relWithCompanion)) },
      check: { name: "Open photos to check in Photoshop.jsx", text: WC.photoshopScript(`Photos to check in ${S.rootName} (${chk.length})`, chk.map(relWithCompanion)) },
    };
  }

  // ------------------------------------------------------------------ decisions on cards
  function setDecision(ids, dec) {
    for (const id of ids) {
      const r = S.resById.get(id);
      if (!r || r.status === "error") continue;
      if (dec === null) S.overrides.delete(r.name);
      else S.overrides.set(r.name, dec);
    }
    saveDecisions();
    decide();
    // update in place (cards stay where they are until you change section)
    for (const id of ids) for (const el of document.querySelectorAll(`.card[data-id="${id}"]`)) {
      const tmp = document.createElement("div"); tmp.innerHTML = cardHtml(S.resById.get(id));
      const nu = tmp.firstElementChild; el.replaceWith(nu); wireCard(nu);
      if (document.activeElement === document.body) nu.focus();
    }
    refreshSideCounts();
    if (!$("lb").hidden) lbRender();
  }

  function refreshSideCounts() { renderSide(); }

  function wireCard(el) {
    el.onclick = (e) => {
      const btn = e.target.closest("button[data-d]");
      if (btn) { e.stopPropagation(); const ids = S.sel.has(el.dataset.id) ? [...S.sel] : [el.dataset.id]; setDecision(ids, btn.classList.contains("on") ? null : btn.dataset.d); return; }
      if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSel(el); return; }
      lbOpen(el.dataset.id, el);
    };
    el.onkeydown = onCardKey;
  }
  function wireCards(c) { for (const el of c.querySelectorAll(".card")) wireCard(el); }
  function toggleSel(el) { const id = el.dataset.id; if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); el.classList.toggle("sel", S.sel.has(id)); }

  function onCardKey(e) {
    const el = e.currentTarget, id = el.dataset.id;
    const ids = S.sel.size && S.sel.has(id) ? [...S.sel] : [id];
    const k = e.key.toLowerCase();
    if (k === "k") setDecision(ids, "keep");
    else if (k === "r") setDecision(ids, "reject");
    else if (k === "c") setDecision(ids, "check");
    else if (k === "u") setDecision(ids, null);
    else if (k === "enter" || k === " ") { e.preventDefault(); lbOpen(id, el); }
    else if (k === "x") toggleSel(el);
    else if (["arrowright", "arrowleft", "arrowdown", "arrowup"].includes(k)) {
      e.preventDefault();
      const cards = [...document.querySelectorAll("#content .card")];
      const i = cards.indexOf(el);
      const perRow = Math.max(1, Math.round(el.parentElement.clientWidth / el.offsetWidth));
      const j = { arrowright: i + 1, arrowleft: i - 1, arrowdown: i + perRow, arrowup: i - perRow }[k];
      if (cards[j]) cards[j].focus();
    } else return;
  }

  document.addEventListener("keydown", (e) => {
    if (!$("lb").hidden) return lbKey(e);
    if ($("review").hidden || !(e.metaKey || e.ctrlKey)) return;
    const root = document.documentElement;
    const cur = parseInt(getComputedStyle(root).getPropertyValue("--thumb")) || 210;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); root.style.setProperty("--thumb", Math.min(480, cur + 40) + "px"); }
    else if (e.key === "-") { e.preventDefault(); root.style.setProperty("--thumb", Math.max(120, cur - 40) + "px"); }
    else if (e.key === "0") { e.preventDefault(); root.style.removeProperty("--thumb"); }
  });

  // ------------------------------------------------------------------ lightbox
  const LB = { id: null, list: [], url: null };
  function lbOpen(id, el) {
    const cards = [...document.querySelectorAll("#content .card")].map((c) => c.dataset.id);
    LB.list = [...new Set(cards)]; LB.id = id; LB.ret = el;
    $("lb").hidden = false;
    lbRender();
  }
  function lbClose() { $("lb").hidden = true; if (LB.url) { URL.revokeObjectURL(LB.url); LB.url = null; } const el = document.querySelector(`#content .card[data-id="${LB.id}"]`); if (el) el.focus(); }
  function lbStep(d) { const i = LB.list.indexOf(LB.id); const j = i + d; if (j >= 0 && j < LB.list.length) { LB.id = LB.list[j]; lbRender(); } }
  function lbKey(e) {
    const k = e.key.toLowerCase();
    if (k === "escape") lbClose();
    else if (k === "arrowright") lbStep(1); else if (k === "arrowleft") lbStep(-1);
    else if (k === "k") setDecision([LB.id], "keep"); else if (k === "r") setDecision([LB.id], "reject");
    else if (k === "c") setDecision([LB.id], "check"); else if (k === "u") setDecision([LB.id], null);
    else return;
    e.preventDefault();
  }
  async function lbRender() {
    const r = S.resById.get(LB.id); if (!r) return;
    const img = $("lbImg");
    img.src = S.thumbs.get(r.id) || "";
    const want = r.id;
    const e = S.byId.get(r.id);
    if (pool && e) {
      const file = e.file || await e.handle.getFile();
      pool.run({ type: "preview", id: r.id, file, isRaw: e.isRaw, edge: 2048 }, true).then((m) => {
        if (LB.id !== want || !m.blob) return;
        if (LB.url) URL.revokeObjectURL(LB.url);
        LB.url = URL.createObjectURL(m.blob); img.src = LB.url;
      });
    }
    const f = r.f || {}, m = f.meta || {};
    const v = r.verdicts || {};
    const lines = WC.CHECKS.map((k) => { const x = v[k] || ["ok", 0, ""]; return `<div><i class="dot ${x[0]}"></i></div><div><b>${esc(WC.LABELS[k])}</b>${x[2] ? `<br><span style="color:#a39887">${esc(x[2])}</span>` : ""}</div>`; }).join("");
    const burst = r.burst_size > 1 ? S.results.filter((x) => x.burst === r.burst) : [];
    const dec = r.override;
    $("lbSide").innerHTML = `<h3>${esc(r.name)}</h3>
      <div>${r.status === "error" ? esc(r.error) : `<span class="pill ${r.status}" style="position:static;display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;color:#fff;text-transform:uppercase">${r.status === "ok" ? "Keep" : r.status}</span> ${r.role === "best" ? "· best of burst ★★★" : r.role === "alternate" ? "· alternate" : ""}`}</div>
      <div class="acts"><button data-d="keep" class="${dec === "keep" ? "on" : ""}">Keep K</button><button data-d="reject" class="${dec === "reject" ? "on" : ""}">Reject R</button><button data-d="check" class="${dec === "check" ? "on" : ""}">Check C</button></div>
      <div class="v">${lines}</div>
      ${burst.length ? `<div style="font-size:13px;margin-bottom:4px">Burst of ${burst.length}</div><div class="strip">${burst.map((x) => `<img src="${S.thumbs.get(x.id) || ""}" data-id="${x.id}" class="${x.id === r.id ? "cur" : ""} ${x.role === "best" ? "best" : ""}" title="${esc(x.name)}">`).join("")}</div>` : ""}
      <div style="font-size:12.5px;color:#a39887;margin-top:14px;line-height:1.7">
        Subject sharpness ${r.sharp ?? "-"} (${esc(r.sharp_src || "")}) · faces ${r.n_faces ?? 0}${r.max_blink != null ? ` · blink ${r.max_blink}` : ""}<br>
        Median brightness ${f.median ?? "-"} · clipped ${f.clip_hi != null ? (f.clip_hi * 100).toFixed(1) + "%" : "-"}<br>
        ${m.time_text ? esc(m.time_text.replace("T", " ")) + " · " : ""}${m.iso ? "ISO " + m.iso + " · " : ""}${m.exposure_time ? (m.exposure_time < 1 ? "1/" + Math.round(1 / m.exposure_time) : m.exposure_time) + " s · " : ""}${m.fnumber ? "f/" + m.fnumber : ""}${m.ec ? " · EC " + (m.ec > 0 ? "+" : "") + m.ec.toFixed(1) : ""}
      </div>
      <p class="keys">← → next · K keep · R reject · C check · U undo · Esc close</p>`;
    for (const b of $("lbSide").querySelectorAll("button[data-d]")) b.onclick = () => setDecision([r.id], b.classList.contains("on") ? null : b.dataset.d);
    for (const t of $("lbSide").querySelectorAll(".strip img")) t.onclick = () => { LB.id = t.dataset.id; if (!LB.list.includes(LB.id)) LB.list.push(LB.id); lbRender(); };
  }
  $("lbClose").onclick = lbClose; $("lbPrev").onclick = () => lbStep(-1); $("lbNext").onclick = () => lbStep(1);

  // ------------------------------------------------------------------ saving
  const MANAGED = () => WC.OUR_KEYWORDS;
  function planFor(r) { return WC.plan(r, cfgNow().output); }
  const writable = (r) => r.status !== "error";

  function modal(html) { $("modalBox").innerHTML = html; $("modal").hidden = false; return $("modalBox"); }
  function closeModal() { $("modal").hidden = true; }
  function toast(t, ms = 3200) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms); }
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function writeFile(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data); await w.close();
  }
  async function readText(dir, name) { try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; } }
  async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }
  const flat = (rel) => rel.replace(/\//g, "__");

  async function saveToFolder() {
    let perm;
    try { perm = await S.root.requestPermission({ mode: "readwrite" }); } catch (e) { perm = "denied"; }
    if (perm !== "granted") { toast("Wedding Cull needs permission to write into the folder. Nothing was changed."); return; }
    const todo = S.results.filter(writable);
    let nEmbed = 0, nNew = 0, nUpd = 0;
    for (const r of todo) {
      const e = S.byId.get(r.id);
      if (!e.isRaw && S.embed) nEmbed++;
      else if (e.sidecar) nUpd++; else nNew++;
    }
    const box = modal(`<h3>Save to “${esc(S.rootName)}”?</h3><ul>
      ${nEmbed ? `<li>Write ratings, labels and keywords <b>inside ${nEmbed.toLocaleString()} JPEGs</b>: metadata only, the image data is not touched. Their previous XMP is backed up to <code>_cull/xmp_backup/</code>.</li>` : ""}
      ${nNew ? `<li>Create <b>${nNew.toLocaleString()} .xmp sidecars</b> next to RAW files.</li>` : ""}
      ${nUpd ? `<li>Update <b>${nUpd.toLocaleString()} existing sidecars</b> (only rating, label and Culling keywords; Camera Raw edits stay; backed up first).</li>` : ""}
      <li><code>_cull/results.csv</code>, <code>_cull/overrides.csv</code> and two Photoshop scripts.</li></ul>
      <p class="muted">Label for “to check”: <b>${esc(cfgNow().output.check_label)}</b> (${S.app === "lightroom" ? "Lightroom Classic" : "Adobe Bridge"}). No photo is moved or deleted.</p>
      <label class="chk muted" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="embedChk" ${S.embed ? "checked" : ""}> Write inside JPEGs (Lightroom and Bridge read JPEG ratings only from inside the file)</label>
      <div class="row"><button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mGo">Save ${todo.length.toLocaleString()} photos</button></div>`);
    box.querySelector("#embedChk").onchange = (ev) => { S.embed = ev.target.checked; closeModal(); saveToFolder(); };
    box.querySelector("#mCancel").onclick = closeModal;
    box.querySelector("#mGo").onclick = () => doSave(todo);
  }

  async function doSave(todo) {
    const box = modal(`<h3>Saving…</h3><div class="meter"><i id="saveBar"></i></div><p class="muted" id="saveTxt"></p>`);
    const cull = await S.root.getDirectoryHandle("_cull", { create: true });
    const backup = await cull.getDirectoryHandle("xmp_backup", { create: true });
    const counts = { embedded: 0, unchanged: 0, created: 0, updated: 0, retired: 0, failed: [] };
    let i = 0;
    for (const r of todo) {
      const e = S.byId.get(r.id), p = planFor(r);
      try {
        if (!e.isRaw && S.embed) {
          const file = await e.handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          const old = WC.jpegXmp(bytes);
          const xmp = old ? WC.mergeXmp(old, p, MANAGED(), WC.OUR_LABELS) : WC.renderXmp(p);
          if (old === xmp) counts.unchanged++;
          else {
            if (old && !(await exists(backup, flat(e.rel) + ".xmp"))) await writeFile(backup, flat(e.rel) + ".xmp", old);
            await writeFile(e.parent, e.name, WC.jpegWithXmp(bytes, xmp));
            counts.embedded++;
          }
          if (e.sidecar) { // a sidecar this tool wrote earlier is stale now
            const t = await readText(e.parent, e.sidecar);
            if (t && WC.isOwnXmp(t)) {
              const old2 = await backup.getDirectoryHandle("old_sidecars", { create: true });
              await writeFile(old2, flat(e.rel.replace(/[^/]+$/, e.sidecar)), t);
              await e.parent.removeEntry(e.sidecar);
              e.sidecar = null; counts.retired++;
            }
          }
        } else {
          const name = e.sidecar || WC.stem(e.name) + ".xmp";
          const t = e.sidecar ? await readText(e.parent, name) : null;
          if (t === null) { await writeFile(e.parent, name, WC.renderXmp(p)); counts.created++; e.sidecar = name; }
          else if (WC.isOwnXmp(t)) { await writeFile(e.parent, name, WC.renderXmp(p)); counts.updated++; }
          else {
            const bk = flat(e.rel.replace(/[^/]+$/, name));
            if (!(await exists(backup, bk))) await writeFile(backup, bk, t);
            await writeFile(e.parent, name, WC.mergeXmp(t, p, MANAGED(), WC.OUR_LABELS)); counts.updated++;
          }
        }
      } catch (err) { counts.failed.push(`${e.rel}: ${err.message || err}`); }
      i++;
      if (i % 5 === 0 || i === todo.length) { box.querySelector("#saveBar").style.width = `${(100 * i) / todo.length}%`; box.querySelector("#saveTxt").textContent = `${i.toLocaleString()} of ${todo.length.toLocaleString()}`; }
    }
    await writeFile(cull, "results.csv", WC.csvRows(S.results));
    await writeFile(cull, "overrides.csv", WC.overridesCsv(S.overrides));
    const ps = psScripts();
    for (const s of Object.values(ps)) await writeFile(cull, s.name, s.text);
    // our writes changed the JPEG files: refresh cache keys so the next visit does not re-analyse them
    for (const r of todo) {
      const e = S.byId.get(r.id);
      if (e.isRaw || !S.embed) continue;
      try { const file = await e.handle.getFile(); const key = `${WC.FEATURE_VERSION}|${S.rootName}/${e.rel}|${file.size}|${file.lastModified}`;
        if (key !== e.key) { const c = await DB.get("feat", e.key); if (c) await DB.put("feat", key, c); e.key = key; } } catch { /* ignore */ }
    }
    const lab = cfgNow().output.check_label;
    const b2 = modal(`<h3>Saved</h3><ul>
      ${counts.embedded ? `<li><b>${counts.embedded.toLocaleString()}</b> JPEGs updated (metadata only)</li>` : ""}
      ${counts.unchanged ? `<li>${counts.unchanged.toLocaleString()} JPEGs already up to date</li>` : ""}
      ${counts.created ? `<li><b>${counts.created.toLocaleString()}</b> sidecars created</li>` : ""}
      ${counts.updated ? `<li><b>${counts.updated.toLocaleString()}</b> sidecars updated</li>` : ""}
      ${counts.retired ? `<li>${counts.retired.toLocaleString()} old Wedding Cull sidecars of JPEGs moved to <code>_cull/xmp_backup/old_sidecars/</code></li>` : ""}
      <li><code>_cull/</code>: results.csv, overrides.csv, Photoshop scripts</li>
      ${counts.failed.length ? `<li style="color:var(--reject)"><b>${counts.failed.length}</b> failed: ${counts.failed.slice(0, 5).map(esc).join("; ")}</li>` : ""}</ul>
      <p class="muted">${S.app === "lightroom" ? "Lightroom Classic: select the photos → <b>Metadata → Read Metadata from Files</b>." : `Bridge: <b>View → Refresh</b>, then Filter by Reject / ★★★ / “${esc(lab)}”.`}</p>
      <div class="row"><button class="btn" id="mApps">All steps</button><button class="btn primary" id="mOk">Done</button></div>`);
    b2.querySelector("#mOk").onclick = closeModal;
    b2.querySelector("#mApps").onclick = () => { closeModal(); S.view = "apps"; render(); };
    window.WCApp.lastSave = counts;
  }

  function downloadZip() {
    const files = [];
    for (const r of S.results) {
      if (!writable(r)) continue;
      const e = S.byId.get(r.id);
      files.push({ name: e.rel.replace(/[^/]+$/, WC.stem(e.name) + ".xmp"), data: WC.renderXmp(planFor(r)) });
    }
    files.push({ name: "_cull/results.csv", data: WC.csvRows(S.results) });
    files.push({ name: "_cull/overrides.csv", data: WC.overridesCsv(S.overrides) });
    for (const s of Object.values(psScripts())) files.push({ name: "_cull/" + s.name, data: s.text });
    files.push({ name: "_cull/README.txt", data:
`Wedding Cull results for ${S.rootName}
Unzip into the event folder so each .xmp sits next to its photo.
Lightroom Classic and Adobe Bridge read these .xmp files for RAW photos (Lightroom: Metadata > Read Metadata from Files).
For JPEGs they read ratings only from inside the file: open Wedding Cull in Chrome or Edge and use "Save to folder".
Photoshop: File > Scripts > Browse... > _cull/Open keepers in Photoshop.jsx
` });
    download(WC.zip(files), `${S.rootName} - Wedding Cull XMP.zip`);
    toast("ZIP downloaded: unzip it into the event folder.");
  }
  window.WCApp.render = render;
  window.WCApp.openFileList = openFileList;
  window.WCApp.decide = decide;

  initStart();
})();
