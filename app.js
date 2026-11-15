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
    strictness: "normal", app: "lightroom", recursive: false, embed: true, keep: 1, lang: "en", details: false,
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
  S.keep = Math.max(1, Math.min(5, store.get("keep", 1) | 0 || 1));
  S.lang = store.get("lang", /^ko\b/i.test(navigator.language || "") ? "ko" : "en") === "ko" ? "ko" : "en";
  S.details = !!store.get("details", false);

  // ------------------------------------------------------------------ language (English / 한국어)
  // tr(en, ko): the visible text in the chosen language. Korean never says 삭제/버림: nothing is deleted.
  const tr = (en, ko) => (S.lang === "ko" ? ko : en);
  const KO_LABELS = { accidental: "실수 컷", blur: "흔들림·초점", missed_focus: "초점 빗나감", eyes: "눈 감음", dark: "너무 어두움", bright: "너무 밝음" };
  const label = (k) => (S.lang === "ko" ? KO_LABELS[k] || WC.LABELS[k] || k : WC.LABELS[k] || k);
  const strictName = (v) => tr({ gentle: "Gentle", normal: "Normal", strict: "Strict" }[v], { gentle: "느슨하게", normal: "보통", strict: "엄격하게" }[v]);
  const statusName = (st) => tr({ ok: "Keep", reject: "Reject", check: "Check" }[st] || st, { ok: "남김", reject: "제외", check: "확인" }[st] || st);
  const decName = (d) => statusName(d === "keep" ? "ok" : d);
  const nPhotos = (n) => (S.lang === "ko" ? `${n.toLocaleString()}장` : plural(n, "photo"));
  /** plain-language reason for one check (beginner words); the measured numbers are behind "details" */
  function plain(r, k) {
    const v = (r.verdicts || {})[k];
    if (!v || v[0] === "ok") return "";
    const t = v[2] || "";
    if (k === "accidental") return /lens cap|blank/.test(t) ? tr("Almost nothing in the frame (lens cap?)", "거의 아무것도 안 찍혔어요 (렌즈 캡?)")
      : tr("No subject, only sky or ground?", "피사체 없이 하늘이나 바닥만 찍혔어요");
    if (k === "blur") return /shake|motion/.test(t) ? tr("Camera shake: the picture is smeared", "카메라가 흔들려서 사진이 번졌어요")
      : tr("Out of focus: the picture is soft", "초점이 안 맞아서 흐릿해요");
    if (k === "missed_focus") return tr("Focus landed in front of or behind the face", "초점이 얼굴이 아니라 앞이나 뒤에 맞았어요");
    if (k === "eyes") { const m = /(\d+) of (\d+) main faces/.exec(t);
      return m ? tr(`Eyes closed (${m[1]} of ${m[2]} people)`, `${m[2]}명 중 ${m[1]}명이 눈을 감았어요`) : tr("Eyes closed", "눈을 감았어요"); }
    if (k === "dark") return tr("Too dark", "너무 어두워요");
    if (k === "bright") return /face/.test(t) ? tr("The face is washed out (too bright)", "얼굴이 하얗게 날아갔어요")
      : tr("Too bright: large areas are pure white", "너무 밝아서 하얗게 날아간 부분이 많아요");
    return t;
  }
  const whyKey = (r) => r.primary || (r.reasons || [])[0] || "";
  const technical = (r) => (r.primary && r.verdicts[r.primary][2]) || (r.reasons || []).map((k) => r.verdicts[k][2]).filter(Boolean)[0] || "";

  // icons (inline SVG sprite in index.html); one per check, status and section
  const ic = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const STATUS_ICON = { reject: "reject", check: "check", ok: "keep", keep: "keep", error: "error" };

  // contact: the Hello World Instagram profile; a feedback form when one exists; GitHub Issues for developers
  const CONTACT = {
    instagram: "https://www.instagram.com/he110w0r1.oi/",
    form: "", // Google Form URL (placeholder: not created yet). Empty = the menu does not show it.
    issues: "https://github.com/codingintheusa0402/wedding-cull-web/issues/new",
    source: "https://github.com/codingintheusa0402/wedding-cull-web",
    guide: "https://github.com/codingintheusa0402/wedding-cull-web#how-to-use-it",
  };

  // static page text (index.html elements with data-i18n); English is read from the page itself
  const KO = {
    privacyTitle: "모든 사진은 이 컴퓨터에서 분석돼요. 아무것도 업로드하지 않아요.",
    ptxt: "사진은 내 컴퓨터에만",
    h1: "사진 2,000장 셀렉,<br>저녁 내내가 아니라<br>몇 분이면.",
    tagline: "웨딩 · 스냅 · 스튜디오 작가를 위한 무료 셀렉 도구",
    b1: "흔들림, 초점 실수, 눈 감은 사진, 노출 실수를 골라내요",
    b2: "연사마다 베스트 컷에 별 ★★★",
    b3: "Lightroom Classic, Bridge, Photoshop에서 바로 이어서 작업",
    pick: "폴더 선택",
    dropHint: "또는 폴더를 여기로 끌어다 놓으세요. JPEG와 RAW (ARW, CR3, CR2, NEF, DNG, RAF, ORF, RW2)",
    demoCap: "실제 속도: 원본 크기 사진 45장을 이 컴퓨터에서 약 12초 만에 분석해요.",
    contact: "문의 · 버그 제보",
    optStrict: "기준", optApp: "편집 프로그램", optKeep: "연사당 남길 컷", optSub: "하위 폴더 포함",
    s1h: "폴더 선택", s1p: "SD 카드에서 바로, 또는 복사본으로. RAW는 내장 미리보기로 읽어서 빨라요.",
    s2h: "표시된 사진만 확인", s2p: "제외할 사진과 확인할 사진만 이유별로 보여 주고, 연사마다 베스트 컷에 별을 달아요.",
    s3h: "편집 프로그램에서 열기", s3p: "별점·라벨·키워드를 표준 XMP로 기록해서 Lightroom, Bridge, Photoshop이 그대로 읽어요.",
    foot: '<a href="https://github.com/codingintheusa0402/wedding-cull-web">GitHub 오픈소스</a>, MIT 라이선스. Mac에서 테스트했어요: Chrome은 폴더에 바로 저장하고, Safari는 ZIP으로 내려받아요. Firefox와 Windows는 테스트 예정이에요.',
    progOf: ' / <span id="progM">0</span>장',
    progStats: '<span>경과 <b id="progElapsed">0:00</b></span><span>남은 시간 <b id="progLeft">-</b></span><span><b id="progRate">-</b> 장/초</span><span>동시 작업 <b id="progWorkers">-</b>개</span>',
    legend: `<span class="lane reject">${ic("reject")}제외 <b id="laneR">0</b></span><span class="lane check">${ic("check")}확인 <b id="laneC">0</b></span><span class="lane ok">${ic("keep")}남김 <b id="laneK">0</b></span>`,
  };
  const EN = {};
  function applyLang() {
    document.documentElement.lang = S.lang;
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const k = el.dataset.i18n;
      if (!(k in EN)) EN[k] = el.innerHTML;
      // keep live numbers while switching during an analysis
      const keep = {}; for (const x of el.querySelectorAll("[id]")) keep[x.id] = x.textContent;
      el.innerHTML = S.lang === "ko" && KO[k] ? KO[k] : EN[k];
      for (const [id, t] of Object.entries(keep)) { const x = el.querySelector("#" + id); if (x) x.textContent = t; }
    }
    for (const el of document.querySelectorAll("[data-i18n-title]")) {
      const k = el.dataset.i18nTitle; if (!(k in EN)) EN[k] = el.title;
      el.title = S.lang === "ko" && KO[k] ? KO[k] : EN[k];
    }
    for (const b of document.querySelectorAll("#strictStart button")) b.textContent = strictName(b.dataset.v);
    const lb = $("langBtn"); if (lb) { lb.textContent = S.lang === "ko" ? "English" : "한국어"; lb.title = S.lang === "ko" ? "Switch to English" : "한국어로 보기"; }
    if ($("themeBtn")) themeLabel();
    if (!$("helpMenu").hidden) $("helpMenu").innerHTML = menuHtml();
    if (typeof initSupport === "function") initSupport();
  }
  function setLang(l) {
    S.lang = l; store.set("lang", l); applyLang();
    if (!$("review").hidden) { renderBar("review"); render(); }
    if (!$("progress").hidden && S.rootName) $("progTitle").textContent = tr(`Analysing ${S.rootName}`, `${S.rootName} 분석 중`);
  }

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
  function initSupport() {
    const sup = $("support");
    sup.innerHTML = canWrite
      ? tr("Your browser can save ratings straight into the folder. Choosing a folder asks for permission; nothing is uploaded.",
        "이 브라우저는 별점을 폴더에 바로 저장할 수 있어요. 폴더를 고르면 권한을 물어보고, 아무것도 업로드하지 않아요.")
      : tr("This browser can read folders but not write to them: you get the ratings as a ZIP of XMP sidecars, which Lightroom and Bridge read for RAW files. For JPEGs and one-click saving use <b>Chrome</b>.",
        "이 브라우저는 폴더를 읽을 수만 있고 쓸 수는 없어요. 별점은 XMP 사이드카 ZIP으로 받게 되는데, Lightroom과 Bridge는 RAW 파일에서만 읽어요. JPEG와 원클릭 저장은 <b>Chrome</b>을 쓰세요.");
    if (!canWrite) sup.classList.add("warn");
  }
  function initStart() {
    applyLang();
    $("langBtn").onclick = () => setLang(S.lang === "ko" ? "en" : "ko");
    seg($("strictStart"), S.strictness, (v) => { S.strictness = v; store.set("strictness", v); });
    seg($("appStart"), S.app, (v) => { S.app = v; store.set("app", v); });
    seg($("keepStart"), String(S.keep), (v) => setKeep(v, false));
    $("recursive").onchange = (e) => { S.recursive = e.target.checked; };
    $("pick").onclick = pickFolder;
    const drop = $("drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", onDrop);
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === drop) pickFolder(); });
    $("themeBtn").onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    $("helpBtn").onclick = (e) => { e.stopPropagation(); toggleMenu($("helpBtn")); };
    $("contactBtn").onclick = (e) => { e.stopPropagation(); toggleMenu($("contactBtn")); };
    document.addEventListener("click", (e) => { if (!$("helpMenu").hidden && !e.target.closest("#helpMenu")) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("helpMenu").hidden) { closeMenu(); e.stopPropagation(); } }, true);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { const v = document.querySelector(".demo video"); if (v) { v.removeAttribute("autoplay"); v.pause(); v.controls = true; } }
  }

  // ------------------------------------------------------------------ theme (dark by default) + help / contact menu
  function setTheme(t) {
    document.documentElement.dataset.theme = t; store.set("theme", t);
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "light" ? "#e9e9e6" : "#1c1c1f";
    themeLabel();
  }
  function themeLabel() {
    const light = document.documentElement.dataset.theme === "light", b = $("themeBtn");
    b.innerHTML = ic(light ? "dark" : "bright");
    b.title = light ? tr("Dark mode", "어두운 화면") : tr("Light mode", "밝은 화면"); b.setAttribute("aria-label", b.title);
    const h = $("helpBtn"); h.title = tr("Help and contact", "도움말 · 문의"); h.setAttribute("aria-label", h.title);
  }
  function menuHtml() {
    const item = (href, icon, title, sub) => `<a role="menuitem" href="${href}" target="_blank" rel="noopener">${ic(icon)}<b>${title}</b><small>${sub}</small></a>`;
    return item(CONTACT.instagram, "ig", tr("Contact and bug reports", "문의 · 버그 제보"), tr("Message @he110w0r1.oi on Instagram", "인스타그램 @he110w0r1.oi로 메시지"))
      + (CONTACT.form ? item(CONTACT.form, "form", tr("Feedback form", "피드백 남기기"), tr("A short form, no account needed", "짧은 설문, 로그인 없이")) : "")
      + item(CONTACT.issues, "bug", tr("Report on GitHub", "GitHub에 이슈 남기기"), tr("For developers: GitHub Issues", "개발자용: GitHub Issues"))
      + `<hr>` + item(CONTACT.guide, "help", tr("How to use it", "사용 방법"), tr("Steps for Lightroom, Bridge and Photoshop", "Lightroom, Bridge, Photoshop에서 여는 방법"))
      + item(CONTACT.source, "code", tr("Source code", "소스 코드"), tr("Open source, MIT license", "오픈소스, MIT 라이선스"));
  }
  function toggleMenu(btn) {
    const m = $("helpMenu");
    if (!m.hidden) { closeMenu(); return; }
    m.innerHTML = menuHtml(); m.hidden = false;
    const r = btn.getBoundingClientRect();
    if (btn.id === "contactBtn") { m.style.top = "auto"; m.style.bottom = `${Math.max(12, innerHeight - r.top + 8)}px`; m.style.left = `${Math.max(12, Math.min(r.left, innerWidth - m.offsetWidth - 12))}px`; m.style.right = "auto"; m.style.position = "fixed"; }
    else { m.style.cssText = ""; }
    btn.setAttribute("aria-expanded", "true"); m.dataset.from = btn.id;
    const first = m.querySelector("a"); if (first) first.focus();
  }
  function closeMenu() {
    const m = $("helpMenu"); m.hidden = true;
    const b = m.dataset.from && $(m.dataset.from); if (b) { b.setAttribute("aria-expanded", "false"); }
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
      } catch (e) { if (e.name !== "AbortError") toast(tr(`Could not open the folder: ${e.message}`, `폴더를 열 수 없어요: ${e.message}`)); }
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
    toast(tr("Drop a folder, not single files.", "파일이 아니라 폴더를 끌어다 놓아 주세요."));
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
    if (!list.length) { toast(tr("No JPEG or RAW photos in that folder" + (S.recursive ? "." : " (turn on Include subfolders?)."),
      "이 폴더에 JPEG나 RAW 사진이 없어요" + (S.recursive ? "." : " (하위 폴더 포함을 켜 보세요)."))); return; }
    const { photos, companions } = WC.pairPhotos(list);
    S.entries = photos; S.companions = companions; S.byId.clear(); S.feats.clear();
    for (const u of S.thumbs.values()) URL.revokeObjectURL(u);
    S.thumbs.clear();
    for (const e of photos) { e.id = await sha12(S.rootName + "/" + e.rel); S.byId.set(e.id, e); }
    const saved = await DB.get("decisions", S.rootName);
    S.overrides = new Map(saved && saved.overrides ? saved.overrides : []);
    show("progress");
    $("progTitle").textContent = tr(`Analysing ${S.rootName}`, `${S.rootName} 분석 중`);
    $("progM").textContent = photos.length.toLocaleString();
    // skeleton tiles: the contact sheet is laid out before the first photo lands
    $("stream").innerHTML = '<div class="sk"></div>'.repeat(Math.min(photos.length, 24));
    const lanes = { reject: 0, check: 0, ok: 0 };
    const laneEl = { reject: "laneR", check: "laneC", ok: "laneK" };
    for (const id of Object.values(laneEl)) if ($(id)) $(id).textContent = "0";
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
      const sk = s.querySelector(".sk"); if (sk) sk.remove();
      while (s.children.length > 60) s.lastChild.remove();
      if (st in lanes) { lanes[st]++; const b = $(laneEl[st]); if (b) { b.textContent = lanes[st].toLocaleString(); b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); } }
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
        $("progNote").textContent = tr("Loading the analysis engine (OpenCV + MediaPipe, once)…", "분석 엔진을 불러오는 중이에요 (OpenCV + MediaPipe, 처음 한 번만)…");
        pool = new Pool(cores());
        const outs = await pool.ready();
        S.faceError = (outs.find((o) => o.faceError) || {}).faceError || null;
        $("progNote").textContent = tr("Measuring sharpness, faces, eyes and exposure on this computer. Nothing is uploaded.", "이 컴퓨터에서 선명도, 얼굴, 눈, 밝기를 재고 있어요. 아무것도 업로드하지 않아요.");
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
    return WC.config(S.strictness, { output: { check_label: S.app === "lightroom" ? WC.ADOBE.lightroom.label : WC.ADOBE.bridge.label },
      bursts: { keep: S.keep } });
  }
  function setKeep(v, rerender = true) {
    S.keep = Math.max(1, Math.min(5, Number(v) || 1)); store.set("keep", S.keep);
    for (const el of document.querySelectorAll(".keepSeg")) for (const b of el.querySelectorAll("button")) {
      b.classList.toggle("on", b.dataset.v === String(S.keep)); b.setAttribute("aria-checked", String(b.dataset.v === String(S.keep))); }
    if (rerender && S.results.length) { decide(); render(); toast(tr(`Keeping the ${S.keep} best of each burst`, `연사마다 베스트 ${S.keep}장을 남겨요`)); }
  }
  const keepSegHtml = () => `<span class="seg keepSeg" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}">${n}</button>`).join("")}</span>`;
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
      <span class="seg" id="strictBar">${["gentle", "normal", "strict"].map((v) => `<button data-v="${v}">${strictName(v)}</button>`).join("")}</span>
      <span class="seg" id="appBar"><button data-v="lightroom">Lightroom</button><button data-v="bridge">Bridge + PS</button></span>
      <span class="topctl">
        ${S.root ? `<button class="btn primary" id="saveBtn">${tr("Save to folder", "폴더에 저장")}</button>` : ""}
        <button class="${S.root ? "linkbtn" : "btn primary"}" id="zipBtn">${tr("Download XMP (ZIP)", "XMP 내려받기 (ZIP)")}</button>
        <button class="linkbtn" id="newBtn" title="${tr("Choose another folder", "다른 폴더 고르기")}">${tr("New folder", "새 폴더")}</button>
      </span>`;
    seg($("strictBar"), S.strictness, (v) => { S.strictness = v; store.set("strictness", v); decide(); render(); toast(tr(`Strictness: ${strictName(v)}`, `기준: ${strictName(v)}`)); });
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
    const link = (v, label, n, icon, st, sub) => `<a data-v="${v}" class="${S.view === v ? "on" : ""}${sub ? " sub" : ""}${st ? " st-" + st : ""}" title="${esc(label)}">${ic(icon)}<em>${esc(label)}</em>${n === null ? "" : `<span>${n.toLocaleString()}</span>`}</a>`;
    let h = link("overview", tr("Overview", "요약"), S.results.length, "overview");
    h += `<h4>${tr("Flagged", "골라낸 사진")}</h4>` + link("reject", tr("Rejects", "제외"), nRej, "reject", "reject");
    for (const [k, l] of g.reject) if (l.length) h += link(`reject:${k}`, label(k), l.length, k, null, true);
    h += link("check", tr("To check", "확인 필요"), nChk, "check", "check");
    for (const [k, l] of g.check) if (l.length) h += link(`check:${k}`, label(k), l.length, k, null, true);
    h += `<h4>${tr("Everything else", "나머지")}</h4>` + link("bursts", tr("Bursts", "연사"), g.bursts.size, "burst", "best") + link("kept", tr("Kept", "남김"), g.kept.length, "keep", "ok");
    if (g.errors.length) h += link("errors", tr("Could not read", "읽을 수 없음"), g.errors.length, "error");
    h += `<h4>${tr("Open in", "열기")}</h4>` + link("apps", tr("Open in your editor", "편집 앱에서 열기"), null, "apps");
    h += `<label class="chk details"><input type="checkbox" id="detailsChk" ${S.details ? "checked" : ""}> ${tr("Show technical details", "자세한 수치 보기")}</label>`;
    side.innerHTML = h;
    for (const a of side.querySelectorAll("a")) a.onclick = () => { S.view = a.dataset.v; S.sel.clear(); render(); window.scrollTo(0, 0); };
    side.querySelector("#detailsChk").onchange = (e) => { S.details = e.target.checked; store.set("details", S.details); render(); if (!$("lb").hidden) lbRender(); };
    return g;
  }

  function renderContent(g, nRej, nChk) {
    const c = $("content");
    const v = S.view;
    if (v === "overview") c.innerHTML = overviewHtml(g, nRej, nChk);
    else if (v === "apps") c.innerHTML = appsHtml();
    else if (v === "bursts") c.innerHTML = burstsHtml(g);
    else if (v === "kept") c.innerHTML = section(tr("Kept", "남김"), g.kept, tr("Photos with no problem found. Best frames of bursts are starred.", "문제가 없는 사진이에요. 연사의 베스트 컷에는 별이 붙어요."));
    else if (v === "errors") c.innerHTML = section(tr("Could not read", "읽을 수 없음"), g.errors, tr("These files could not be decoded (damaged, or a RAW without an embedded preview).", "열 수 없는 파일이에요 (손상됐거나, 내장 미리보기가 없는 RAW)."));
    else {
      const [st, k] = v.split(":");
      const m = g[st];
      const title = st === "reject" ? tr("Rejects", "제외") : tr("To check", "확인 필요");
      if (k) c.innerHTML = section(`${title}: ${label(k)}`, m.get(k) || []);
      else {
        const keys = tr("Press <b>K</b> keep · <b>R</b> reject · <b>C</b> check · <b>U</b> undo · <b>Enter</b> full size.", "<b>K</b> 남김 · <b>R</b> 제외 · <b>C</b> 확인 · <b>U</b> 되돌리기 · <b>Enter</b> 크게 보기");
        const what = st === "reject" ? tr("Marked Reject in Lightroom / Bridge.", "Lightroom / Bridge에서 제외(Reject)로 표시돼요. 원본 파일은 그대로예요.")
          : tr(`Get the yellow label (“${esc(cfgNow().output.check_label)}”).`, `노란 라벨(“${esc(cfgNow().output.check_label)}”)이 붙어요.`);
        let x = `<div class="sec"><h2>${title}</h2><span>${(st === "reject" ? nRej : nChk).toLocaleString()}</span></div>
          <p class="hint">${what} ${keys}</p>`;
        for (const [kk, l] of m) if (l.length) x += section(label(kk), l, null, kk);
        if (!(st === "reject" ? nRej : nChk)) x += `<p class="empty">${tr("Nothing here.", "없어요.")}</p>`;
        c.innerHTML = x;
      }
    }
    wireCards(c);
    wireApps(c);
    for (const el of c.querySelectorAll(".keepSeg")) seg(el, String(S.keep), (v) => setKeep(v));
  }

  function overviewHtml(g, nRej, nChk) {
    const st = S.stats || {};
    const alt = S.results.filter((r) => r.role === "alternate").length;
    const speed = st.analysed ? tr(`${plural(st.analysed, "photo")} analysed in ${fmtTime(st.seconds)}${st.cached ? `, ${st.cached.toLocaleString()} from the last run` : ""}`,
      `${st.analysed.toLocaleString()}장을 ${fmtTime(st.seconds)}에 분석${st.cached ? `, ${st.cached.toLocaleString()}장은 지난번 결과` : ""}`)
      : tr(`${plural(st.cached || 0, "photo")} from the last run`, `${(st.cached || 0).toLocaleString()}장 모두 지난번 결과`);
    const nOk = g.kept.length;
    let h = `<div class="sec"><h2>${esc(S.rootName)}</h2><span class="meta">${speed}. ${tr("Strictness", "기준")}: ${strictName(S.strictness)}</span></div>
      <div class="summary">
        <div class="tile"><b>${S.results.length.toLocaleString()}</b><span>${ic("overview")}${tr("photos", "전체")}</span></div>
        <div class="tile reject"><b>${nRej.toLocaleString()}</b><span>${ic("reject")}${tr("rejects", "제외")}</span></div>
        <div class="tile check"><b>${nChk.toLocaleString()}</b><span>${ic("check")}${tr("to check", "확인 필요")}</span></div>
        <div class="tile ok"><b>${nOk.toLocaleString()}</b><span>${ic("keep")}${tr("kept", "남김")}</span></div>
      </div>
      <div class="ratio" role="img" aria-label="${tr(`${nRej} rejects, ${nChk} to check, ${nOk} kept`, `제외 ${nRej}, 확인 ${nChk}, 남김 ${nOk}`)}"><i class="reject" style="flex-grow:${nRej}"></i><i class="check" style="flex-grow:${nChk}"></i><i class="ok" style="flex-grow:${nOk}"></i></div>
      <p class="sub-stat">${ic("burst")}<span class="tile best"><b>${g.bursts.size.toLocaleString()}</b></span>${tr(`bursts, ${alt.toLocaleString()} alternate frames (rejected or kept as alternates)`, `연사, 다른 컷 ${alt.toLocaleString()}장 (베스트가 아닌 컷)`)}</p>`;
    if (S.faceError) h += `<p class="hint">⚠️ ${tr(`Face and closed-eye checks are off in this browser (no WebGL): ${esc(S.faceError)}. Blur, exposure and bursts still work.`, `이 브라우저에서는 얼굴·눈 감음 검사가 꺼져 있어요 (WebGL 없음): ${esc(S.faceError)}. 흔들림, 밝기, 연사는 그대로 돼요.`)}</p>`;
    const cnt = (n) => `<td class="${n ? "" : "z"}">${n}</td>`;
    const rows = WC.CHECKS.map((k) => `<tr><td><span class="rl">${ic(k)}${esc(label(k))}</span></td>${cnt((g.reject.get(k) || []).length)}${cnt((g.check.get(k) || []).length)}</tr>`).join("");
    h += `<div class="panels"><div class="app"><h3>${tr("Flagged by reason", "이유별")}</h3>
      <table class="reasons"><tr><th></th><th>${tr("reject", "제외")}</th><th>${tr("check", "확인")}</th></tr>${rows}</table></div>
      <div class="app"><h3>${tr("Next", "다음 단계")}</h3><ol><li>${tr("Look through <b>Rejects</b> and <b>To check</b>; fix any wrong call with K / R / C.", "<b>제외</b>와 <b>확인 필요</b>를 훑어보고, 잘못 고른 건 K / R / C로 고치세요.")}</li>
      <li>${S.root ? tr("<b>Save to folder</b> writes ratings, labels and keywords (XMP).", "<b>폴더에 저장</b>을 누르면 별점·라벨·키워드(XMP)가 기록돼요.") : tr("<b>Download XMP (ZIP)</b> and unzip it into the event folder.", "<b>XMP 내려받기 (ZIP)</b> 후 행사 폴더에 압축을 푸세요.")}</li>
      <li>${tr(`Open the folder in <b>${S.app === "lightroom" ? "Lightroom Classic" : "Bridge / Photoshop"}</b> (steps under <a href="#" data-go="apps">Open in</a>).`, `<b>${S.app === "lightroom" ? "Lightroom Classic" : "Bridge / Photoshop"}</b>에서 폴더를 여세요 (방법은 <a href="#" data-go="apps">열기</a>).`)}</li></ol></div></div>`;
    const preview = S.results.filter((r) => r.status === "reject" || r.status === "check").slice(0, 24);
    if (preview.length) h += section(tr("Flagged photos", "골라낸 사진"), preview, tr("The first flagged photos. All of them are under Rejects and To check.", "골라낸 사진 중 일부예요. 전부 보려면 제외와 확인 필요를 누르세요."));
    return h;
  }

  function section(title, list, hint, sub) {
    if (!list.length) return `<div class="sec"><h2>${esc(title)}</h2></div><p class="empty">${tr("Nothing here.", "없어요.")}</p>`;
    return `<div class="sec">${sub ? `<h3>${ic(sub)}${esc(title)}</h3>` : `<h2>${esc(title)}</h2>`}<span>${list.length.toLocaleString()}</span></div>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}<div class="grid">${list.map(cardHtml).join("")}</div>`;
  }

  function cardHtml(r) {
    const url = S.thumbs.get(r.id) || "";
    const flagged = r.status === "error" ? r.error : (S.details ? technical(r) : plain(r, whyKey(r))) || technical(r);
    const why = flagged || (r.role === "best" ? tr("Best frame of its burst", "연사 중 베스트 컷") : r.role === "alternate" ? tr("Alternate of a burst", "연사 중 다른 컷") : tr("No problem found", "문제 없음"));
    const stars = r.status !== "reject" && (r.role === "best" || r.role === "single") ? "★★★" : "";
    const pill = r.status === "reject" || r.status === "check" ? statusName(r.status) : "";
    const dec = r.override;
    return `<div class="card${r.status === "reject" ? " dim" : ""}${r.role === "best" ? " best" : ""}${S.sel.has(r.id) ? " sel" : ""}" tabindex="0" data-id="${r.id}">
      <div class="im">${url ? `<img src="${url}" alt="${esc(r.name)}" loading="lazy">` : ""}${pill ? `<span class="pill ${r.status}">${ic(STATUS_ICON[r.status])}${pill}</span>` : ""}${stars ? `<span class="star">${stars}</span>` : ""}${dec ? `<span class="ov">${tr("you", "직접")}: ${decName(dec)}</span>` : ""}</div>
      <div class="meta"><div class="nm" title="${esc(r.name)}">${esc(r.name)}</div><div class="why">${esc(why)}</div>
      ${r.status === "error" ? "" : `<div class="acts">${["keep", "reject", "check"].map((d) => `<button data-d="${d}" class="${dec === d ? "on" : ""}${(d === "keep" ? "ok" : d) === r.status ? " is is-" + d : ""}" title="${decName(d)} (${d[0].toUpperCase()})">${decName(d)}</button>`).join("")}</div>`}</div></div>`;
  }

  function burstsHtml(g) {
    const ctl = `<div class="keepctl"><span>${tr("Keep the best", "연사마다 베스트")}</span>${keepSegHtml()}<span>${tr("of each burst", "장 남기기")}</span></div>`;
    if (!g.bursts.size) return `<div class="sec"><h2>${tr("Bursts", "연사")}</h2></div>${ctl}<p class="empty">${tr("No bursts found (photos taken within a couple of seconds that look alike).", "연사가 없어요 (몇 초 안에 찍은 비슷한 사진).")}</p>`;
    const nb = S.keep === 1 ? tr("The best one (sharpest, eyes open, best exposure) is outlined and gets ★★★; the others are alternates.", "가장 좋은 컷(가장 선명하고, 눈을 뜨고, 밝기가 좋은 컷)에 테두리와 ★★★가 붙고, 나머지는 다른 컷이 돼요.")
      : tr(`The ${S.keep} best (sharpest, eyes open, best exposure) are outlined and get ★★★; the others are alternates.`, `가장 좋은 ${S.keep}장(가장 선명하고, 눈을 뜨고, 밝기가 좋은 컷)에 테두리와 ★★★가 붙고, 나머지는 다른 컷이 돼요.`);
    let h = `<div class="sec"><h2>${tr("Bursts", "연사")}</h2><span>${g.bursts.size.toLocaleString()}</span></div>${ctl}<p class="hint">${tr("Frames taken seconds apart that look alike.", "몇 초 간격으로 찍은 비슷한 사진이에요.")} ${nb}</p>`;
    for (const [b, list] of g.bursts) {
      const best = list.filter((r) => r.role === "best").map((r) => r.name);
      h += `<div class="burst"><header><span><b>${tr(`Burst ${b}`, `연사 ${b}`)}</b>, ${tr(`${list.length} frames`, `${list.length}장`)}</span><span>${tr("Best", "베스트")}: ${esc(best.length ? best.join(", ") : "-")}</span></header><div class="grid">${list.map(cardHtml).join("")}</div></div>`;
    }
    return h;
  }

  function appsHtml() {
    const lab = cfgNow().output.check_label;
    const saved = S.root ? tr("Click <b>Save to folder</b> (top right).", "오른쪽 위 <b>폴더에 저장</b>을 누르세요.")
      : tr("Click <b>Download XMP (ZIP)</b> and unzip it into the event folder, next to the photos (RAW files only: for JPEGs open Wedding Cull in Chrome).",
        "<b>XMP 내려받기 (ZIP)</b>를 누르고 행사 폴더의 사진 옆에 압축을 푸세요 (RAW만 해당: JPEG는 Chrome에서 Wedding Cull을 여세요).");
    if (S.lang === "ko") return `<div class="sec"><h2>Lightroom, Bridge, Photoshop에서 열기</h2></div>
      <p class="hint">Wedding Cull은 표준 XMP 메타데이터를 기록해요: 제외 사진은 <b>Reject</b>(별점 −1), 확인할 사진은 노란 라벨 “${esc(lab)}”, 연사의 베스트 컷과 좋은 단독 컷은 ★★★, 그리고 <code>Culling|Blur / camera shake</code> 같은 키워드. ${S.root ? "JPEG는 파일 안에(사진 데이터는 그대로), RAW는 옆에 .xmp 사이드카로." : ".xmp 사이드카로."} 메뉴 이름은 영문 기준이에요.</p>
      <div class="apps">
        <div class="app"><h3><span class="badge lr">Lr</span>Lightroom Classic</h3><ol>
          <li>${saved}${S.app !== "lightroom" ? ' 먼저 위쪽 막대를 <b>Lightroom</b>으로 바꾸세요 (노란 라벨 = “Yellow”).' : ""}</li>
          <li><b>File → Import</b>로 폴더를 가져오거나, 이미 카탈로그에 있으면 사진을 고르고 <b>Metadata → Read Metadata from Files</b>.</li>
          <li><b>Attribute</b> 필터 막대로 <b>Rejected</b>, <b>★★★</b>, <b>노란</b> 라벨을 거르거나, <b>Keyword</b> 열에서 “Culling”을 고르세요.</li></ol></div>
        <div class="app"><h3><span class="badge br">Br</span>Adobe Bridge</h3><ol>
          <li>${saved}${S.app !== "bridge" ? ' 먼저 위쪽 막대를 <b>Bridge + PS</b>로 바꾸세요 (노란 라벨 = “Second”).' : ""}</li>
          <li>Bridge에서 폴더를 여세요 (이미 열려 있었다면 <b>View → Refresh</b>).</li>
          <li><b>Filter</b> 패널: <b>Ratings → Reject</b>, <b>★★★</b>, <b>Labels → ${esc(lab)}</b>, <b>Keywords → Culling</b>.</li></ol></div>
        <div class="app"><h3><span class="badge ps">Ps</span>Photoshop</h3><ol>
          <li>${S.root ? "<b>폴더에 저장</b>하면 <code>_cull/</code> 안에 스크립트 두 개도 만들어져요." : "아래에서 스크립트를 내려받아 행사 폴더의 <code>_cull</code> 폴더에 넣으세요 (다른 곳에 두면 폴더를 물어봐요)."}</li>
          <li>Photoshop에서 <b>File → Scripts → Browse…</b>를 누르고 <code>Open keepers in Photoshop.jsx</code>(남길 사진) 또는 <code>Open photos to check in Photoshop.jsx</code>(확인할 사진)를 고르세요. RAW는 Camera Raw로 열려요.</li>
          <li>또는 Bridge에서 사진을 고르고 <b>File → Open With → Photoshop</b>.</li></ol>
          <div class="topctl"><button class="btn" data-ps="keepers">남길 사진 스크립트</button><button class="btn" data-ps="check">확인할 사진 스크립트</button></div></div>
      </div>
      <p class="hint" style="margin-top:14px">데스크톱 Wedding Cull용 결정 파일: <button class="btn" id="ovBtn">overrides.csv</button> <button class="btn" id="csvBtn">results.csv</button></p>`;
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
      if (dec) nu.classList.add("landed", "l-" + dec);
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
    const lines = WC.CHECKS.map((k) => { const x = v[k] || ["ok", 0, ""]; const p = plain(r, k);
      return `<div class="${x[0]}">${ic(k)}<div><b>${esc(label(k))}</b>${p ? `<div class="p">${esc(p)}</div>` : x[0] === "ok" ? `<div class="t">${tr("No problem", "문제 없음")}</div>` : ""}${S.details && x[2] ? `<div class="t">${esc(x[2])}</div>` : ""}</div></div>`; }).join("");
    const burst = r.burst_size > 1 ? S.results.filter((x) => x.burst === r.burst) : [];
    const dec = r.override;
    $("lbSide").innerHTML = `<h3>${esc(r.name)}</h3>
      <div class="status">${r.status === "error" ? esc(r.error) : `<span class="pill ${r.status}">${ic(STATUS_ICON[r.status])}${statusName(r.status)}</span> ${r.role === "best" ? tr("Best of its burst ★★★", "연사 베스트 ★★★") : r.role === "alternate" ? tr("Alternate in a burst", "연사 중 다른 컷") : ""}`}</div>
      <div class="acts"><button data-d="keep" class="${dec === "keep" ? "on" : ""}">${decName("keep")}<kbd>K</kbd></button><button data-d="reject" class="${dec === "reject" ? "on" : ""}">${decName("reject")}<kbd>R</kbd></button><button data-d="check" class="${dec === "check" ? "on" : ""}">${decName("check")}<kbd>C</kbd></button></div>
      <div class="v">${lines}</div>
      ${burst.length ? `<div class="bl">${tr(`Burst of ${burst.length}`, `연사 ${burst.length}장`)}</div><div class="strip">${burst.map((x) => `<img src="${S.thumbs.get(x.id) || ""}" data-id="${x.id}" class="${x.id === r.id ? "cur" : ""} ${x.role === "best" ? "best" : ""}" title="${esc(x.name)}">`).join("")}</div>` : ""}
      ${S.details ? `<div class="tech">
        Subject sharpness ${r.sharp ?? "-"} (${esc(r.sharp_src || "")}) · faces ${r.n_faces ?? 0}${r.max_blink != null ? ` · blink ${r.max_blink}` : ""}<br>
        Median brightness ${f.median ?? "-"} · clipped ${f.clip_hi != null ? (f.clip_hi * 100).toFixed(1) + "%" : "-"}<br>
        ${m.time_text ? esc(m.time_text.replace("T", " ")) + " · " : ""}${m.iso ? "ISO " + m.iso + " · " : ""}${m.exposure_time ? (m.exposure_time < 1 ? "1/" + Math.round(1 / m.exposure_time) : m.exposure_time) + " s · " : ""}${m.fnumber ? "f/" + m.fnumber : ""}${m.ec ? " · EC " + (m.ec > 0 ? "+" : "") + m.ec.toFixed(1) : ""}
      </div>` : ""}
      <p class="keys">${tr("← → next · K keep · R reject · C check · U undo · Esc close", "← → 다음 · K 남김 · R 제외 · C 확인 · U 되돌리기 · Esc 닫기")}</p>`;
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
    if (perm !== "granted") { toast(tr("Wedding Cull needs permission to write into the folder. Nothing was changed.", "폴더에 쓰려면 권한이 필요해요. 아무것도 바뀌지 않았어요.")); return; }
    const todo = S.results.filter(writable);
    let nEmbed = 0, nNew = 0, nUpd = 0;
    for (const r of todo) {
      const e = S.byId.get(r.id);
      if (!e.isRaw && S.embed) nEmbed++;
      else if (e.sidecar) nUpd++; else nNew++;
    }
    const appName = S.app === "lightroom" ? "Lightroom Classic" : "Adobe Bridge";
    const box = S.lang === "ko" ? modal(`<h3>“${esc(S.rootName)}”에 저장할까요?</h3><ul>
      ${nEmbed ? `<li><b>JPEG ${nEmbed.toLocaleString()}장 안에</b> 별점·라벨·키워드를 기록해요. 메타데이터만 바뀌고 사진 데이터는 그대로예요. 기존 XMP는 <code>_cull/xmp_backup/</code>에 백업해요.</li>` : ""}
      ${nNew ? `<li>RAW 파일 옆에 <b>.xmp 사이드카 ${nNew.toLocaleString()}개</b>를 만들어요.</li>` : ""}
      ${nUpd ? `<li><b>기존 사이드카 ${nUpd.toLocaleString()}개</b>를 고쳐요 (별점, 라벨, Culling 키워드만. Camera Raw 보정은 그대로, 먼저 백업).</li>` : ""}
      <li><code>_cull/results.csv</code>, <code>_cull/overrides.csv</code>, Photoshop 스크립트 두 개.</li></ul>
      <p class="muted">“확인 필요” 라벨: <b>${esc(cfgNow().output.check_label)}</b> (${appName}). 사진은 옮기지 않고 원본 그대로 둬요.</p>
      <label class="chk muted" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="embedChk" ${S.embed ? "checked" : ""}> JPEG 안에 기록 (Lightroom과 Bridge는 JPEG 별점을 파일 안에서만 읽어요)</label>
      <div class="row"><button class="btn" id="mCancel">취소</button><button class="btn primary" id="mGo">${todo.length.toLocaleString()}장 저장</button></div>`)
      : modal(`<h3>Save to “${esc(S.rootName)}”?</h3><ul>
      ${nEmbed ? `<li>Write ratings, labels and keywords <b>inside ${nEmbed.toLocaleString()} JPEGs</b>: metadata only, the image data is not touched. Their previous XMP is backed up to <code>_cull/xmp_backup/</code>.</li>` : ""}
      ${nNew ? `<li>Create <b>${nNew.toLocaleString()} .xmp sidecars</b> next to RAW files.</li>` : ""}
      ${nUpd ? `<li>Update <b>${nUpd.toLocaleString()} existing sidecars</b> (only rating, label and Culling keywords; Camera Raw edits stay; backed up first).</li>` : ""}
      <li><code>_cull/results.csv</code>, <code>_cull/overrides.csv</code> and two Photoshop scripts.</li></ul>
      <p class="muted">Label for “to check”: <b>${esc(cfgNow().output.check_label)}</b> (${appName}). No photo is moved or deleted.</p>
      <label class="chk muted" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="embedChk" ${S.embed ? "checked" : ""}> Write inside JPEGs (Lightroom and Bridge read JPEG ratings only from inside the file)</label>
      <div class="row"><button class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mGo">Save ${todo.length.toLocaleString()} photos</button></div>`);
    box.querySelector("#embedChk").onchange = (ev) => { S.embed = ev.target.checked; closeModal(); saveToFolder(); };
    box.querySelector("#mCancel").onclick = closeModal;
    box.querySelector("#mGo").onclick = () => doSave(todo);
  }

  async function doSave(todo) {
    const box = modal(`<h3>${tr("Saving…", "저장 중…")}</h3><div class="meter"><i id="saveBar"></i></div><p class="muted" id="saveTxt"></p>`);
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
      if (i % 5 === 0 || i === todo.length) { box.querySelector("#saveBar").style.width = `${(100 * i) / todo.length}%`; box.querySelector("#saveTxt").textContent = tr(`${i.toLocaleString()} of ${todo.length.toLocaleString()}`, `${i.toLocaleString()} / ${todo.length.toLocaleString()}장`); }
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
    const b2 = modal(`<h3>${tr("Saved", "저장했어요")}</h3><ul>
      ${counts.embedded ? `<li>${tr(`<b>${counts.embedded.toLocaleString()}</b> JPEGs updated (metadata only)`, `JPEG <b>${counts.embedded.toLocaleString()}</b>장 기록 (메타데이터만)`)}</li>` : ""}
      ${counts.unchanged ? `<li>${tr(`${counts.unchanged.toLocaleString()} JPEGs already up to date`, `JPEG ${counts.unchanged.toLocaleString()}장은 이미 최신`)}</li>` : ""}
      ${counts.created ? `<li>${tr(`<b>${counts.created.toLocaleString()}</b> sidecars created`, `사이드카 <b>${counts.created.toLocaleString()}</b>개 생성`)}</li>` : ""}
      ${counts.updated ? `<li>${tr(`<b>${counts.updated.toLocaleString()}</b> sidecars updated`, `사이드카 <b>${counts.updated.toLocaleString()}</b>개 갱신`)}</li>` : ""}
      ${counts.retired ? `<li>${tr(`${counts.retired.toLocaleString()} old Wedding Cull sidecars of JPEGs moved to <code>_cull/xmp_backup/old_sidecars/</code>`, `예전 JPEG 사이드카 ${counts.retired.toLocaleString()}개를 <code>_cull/xmp_backup/old_sidecars/</code>로 옮김`)}</li>` : ""}
      <li><code>_cull/</code>: results.csv, overrides.csv, ${tr("Photoshop scripts", "Photoshop 스크립트")}</li>
      ${counts.failed.length ? `<li style="color:var(--reject)">${tr(`<b>${counts.failed.length}</b> failed`, `<b>${counts.failed.length}</b>개 실패`)}: ${counts.failed.slice(0, 5).map(esc).join("; ")}</li>` : ""}</ul>
      <p class="muted">${S.app === "lightroom" ? tr("Lightroom Classic: select the photos → <b>Metadata → Read Metadata from Files</b>.", "Lightroom Classic: 사진을 고르고 → <b>Metadata → Read Metadata from Files</b>.") : tr(`Bridge: <b>View → Refresh</b>, then Filter by Reject / ★★★ / “${esc(lab)}”.`, `Bridge: <b>View → Refresh</b> 후 Reject / ★★★ / “${esc(lab)}”로 거르세요.`)}</p>
      <div class="row"><button class="btn" id="mApps">${tr("All steps", "전체 방법")}</button><button class="btn primary" id="mOk">${tr("Done", "완료")}</button></div>`);
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
For JPEGs they read ratings only from inside the file: open Wedding Cull in Chrome and use "Save to folder".
Photoshop: File > Scripts > Browse... > _cull/Open keepers in Photoshop.jsx
` });
    download(WC.zip(files), `${S.rootName} - Wedding Cull XMP.zip`);
    toast(tr("ZIP downloaded: unzip it into the event folder.", "ZIP을 받았어요. 행사 폴더에 압축을 푸세요."));
  }
  window.WCApp.render = render;
  window.WCApp.openFileList = openFileList;
  window.WCApp.decide = decide;
  window.WCApp.setLang = setLang;
  window.WCApp.setKeep = setKeep;

  initStart();
})();
