/* Wedding Cull web: configuration, decisions and burst grouping.
   A line-by-line port of the desktop engine (wedding_cull/config.py, decide.py, bursts.py, pipeline.decide_all),
   so thresholds tuned for the desktop tool mean the same here. Pure functions; runs in the page, in workers and
   in Node (tests). */
(function (root) {
  "use strict";
  const WC = root.WC = root.WC || {};

  // ------------------------------------------------------------------ configuration (default.toml)
  WC.DEFAULTS = {
    thresholds: {
      blur_reject: 11.5, blur_check: 15.5, missed_focus_ratio: 1.6,
      face_energy_reject: 0.15, face_energy_check: 0.35, frame_energy_reject: 0.35, frame_energy_check: 0.8,
      eyes_closed_reject: 0.55, eyes_closed_check: 0.40, min_face_px: 60, main_face_rel: 0.45,
      dark_median: 38, dark_reject_median: 18, dark_p98: 130, dark_reject_p98: 100, face_ok_luma: 90,
      bright_clip: 0.22, bright_clip_reject: 0.45, face_clip_check: 0.35, face_clip_reject: 0.5,
      face_blown_luma: 238, lowkey_ec: -0.7, highkey_ec: 0.7, blank_std: 7.0, blank_edges: 0.004,
    },
    bursts: { max_gap_s: 2.5, max_span_s: 20.0, hash_dist: 14, hash_dist_tight: 22, no_time_hash_dist: 10, keep: 1 },
    output: { star_best: 3, star_singles: true, check_label: "Second", keywords: true },
    strictness: { gentle: 0.8, normal: 1.0, strict: 1.25 },
  };

  // value * s ** (direction * damping); direction +1 = a bigger value flags more photos
  const STRICTNESS_RULES = {
    blur_reject: [1, 1.0], blur_check: [1, 1.0], missed_focus_ratio: [-1, 0.5],
    face_energy_reject: [1, 1.0], face_energy_check: [1, 1.0], frame_energy_reject: [1, 1.0],
    frame_energy_check: [1, 1.0], dark_p98: [1, 0.5], dark_reject_p98: [1, 0.5], face_clip_check: [-1, 0.5],
    face_clip_reject: [-1, 0.5], eyes_closed_reject: [-1, 0.5], eyes_closed_check: [-1, 0.5],
    dark_median: [1, 1.0], dark_reject_median: [1, 1.0], face_ok_luma: [1, 0.5], bright_clip: [-1, 1.0],
    bright_clip_reject: [-1, 1.0], face_blown_luma: [-1, 0.1], blank_std: [1, 0.5], blank_edges: [1, 0.5],
  };

  WC.config = function (strictness = "normal", overrides = {}) {
    const cfg = JSON.parse(JSON.stringify(WC.DEFAULTS));
    for (const [sec, vals] of Object.entries(overrides || {})) Object.assign(cfg[sec] = cfg[sec] || {}, vals);
    if (!(strictness in cfg.strictness)) throw new Error(`unknown strictness ${strictness}`);
    const s = cfg.strictness[strictness];
    const th = cfg.thresholds;
    for (const [k, [dir, damp]] of Object.entries(STRICTNESS_RULES)) if (k in th) th[k] = th[k] * Math.pow(s, dir * damp);
    th.eyes_closed_reject = Math.min(th.eyes_closed_reject, 0.95);
    th.eyes_closed_check = Math.min(th.eyes_closed_check, th.eyes_closed_reject - 0.02);
    cfg.strictness_name = strictness;
    return cfg;
  };

  // ------------------------------------------------------------------ decisions (decide.py)
  const OK = "ok", CHECK = "check", REJECT = "reject";
  const RANK = { ok: 0, check: 1, reject: 2 };
  WC.CHECKS = ["accidental", "blur", "missed_focus", "eyes", "dark", "bright"];
  WC.LABELS = {
    accidental: "Accidental frame", blur: "Blur / camera shake", missed_focus: "Missed focus",
    eyes: "Closed eyes", dark: "Too dark", bright: "Too bright",
  };
  const fmt0 = (x) => pyFixed(x, 0), fmt2 = (x) => pyFixed(x, 2);
  function pyFixed(x, d) { return Number(x).toFixed(d); }
  const signed1 = (x) => (x >= 0 ? "+" : "") + Number(x).toFixed(1);

  function mainFaces(f, th) {
    const faces = f.faces || [];
    if (!faces.length) return [];
    const big = faces[0].h;
    return faces.filter((x) => x.h >= th.main_face_rel * big && x.h >= th.min_face_px);
  }
  WC.mainFaces = mainFaces;

  function judgedFaces(f, th) {
    return mainFaces(f, th).filter((x) => x.sharp != null && x.h >= 100);
  }

  function focus(sharp, energy, th, kind) {
    const [eRej, eChk] = kind === "face" ? [th.face_energy_reject, th.face_energy_check]
      : [th.frame_energy_reject, th.frame_energy_check];
    const score = Math.min(sharp / th.blur_check, energy / eChk);
    if (sharp < th.blur_reject || energy < eRej) return [REJECT, score];
    if (sharp < th.blur_check || energy < eChk) return [CHECK, score];
    return [OK, score];
  }

  const get = (o, k, d) => (o[k] === undefined || o[k] === null ? d : o[k]);

  function subjectFocus(f, th) {
    const faces = judgedFaces(f, th);
    if (faces.length) {
      let best = null;
      for (const x of faces) {
        const [st, sc] = focus(x.sharp, get(x, "energy", 9.9), th, "face");
        if (best === null || sc > best.score) {
          best = { status: st, score: sc, sharp: x.sharp, energy: get(x, "energy", 9.9),
            spread: get(x, "spread", 1.0), where: "face" };
        }
      }
      return best;
    }
    const [st, sc] = focus(f.tile_sharp, get(f, "tile_energy", 9.9), th, "frame");
    return { status: st, score: sc, sharp: f.tile_sharp, energy: get(f, "tile_energy", 9.9),
      spread: get(f, "spread", 1.0), where: "frame" };
  }
  WC.subjectFocus = subjectFocus;

  const r3 = (x) => Math.round(x * 1000) / 1000, r4 = (x) => Math.round(x * 10000) / 10000,
    r5 = (x) => Math.round(x * 100000) / 100000;

  WC.evaluate = function (f, th) {
    const out = {};
    const meta = f.meta || {};
    const ec = meta.ec || 0.0;
    const faces = f.faces || [];
    const mf = mainFaces(f, th);

    // blur + missed focus
    const sf = subjectFocus(f, th);
    let st = OK, reason = "", mfSt = OK, mfReason = "";
    if (sf.status !== OK) {
      const elsewhere = get(f, "tile_sharp_max", f.tile_sharp);
      if (sf.where === "face" && elsewhere >= 1.25 * th.blur_check && elsewhere > th.missed_focus_ratio * sf.sharp
        && get(f, "tile_energy", 0) >= th.frame_energy_check) {
        mfSt = sf.status;
        mfReason = `face soft (sharpness ${fmt0(sf.sharp)}) while another area is sharp (${fmt0(elsewhere)}) - ` +
          "focus landed behind/in front of the subject";
      } else {
        st = sf.status;
        const eChk = sf.where === "face" ? th.face_energy_check : th.frame_energy_check;
        const shake = sf.energy < eChk && (sf.sharp >= th.blur_check || sf.spread > 1.6);
        const kind = shake ? "camera shake / motion blur" : "out of focus / soft";
        reason = `${sf.where} sharpness ${fmt0(sf.sharp)}, detail ${fmt2(sf.energy)} - ${kind}`;
      }
    }
    out.blur = [st, r3(sf.score), reason];
    out.missed_focus = [mfSt, r3(sf.score), mfReason];

    // eyes: only faces sharp enough to read
    st = OK; reason = ""; let worst = 0.0;
    const judged = mf.filter((x) => x.blink != null && (x.sharp == null || x.sharp >= th.blur_reject));
    if (judged.length) {
      worst = Math.max(...judged.map((x) => x.blink));
      const nClosed = judged.filter((x) => x.blink >= th.eyes_closed_check).length;
      if (worst >= th.eyes_closed_reject) st = REJECT;
      else if (worst >= th.eyes_closed_check) st = CHECK;
      if (st !== OK) {
        const who = judged.length === 1 ? "the main face" : `${nClosed} of ${judged.length} main faces`;
        reason = `eyes closed / looking down on ${who} (blink ${fmt2(worst)})`;
      }
    }
    out.eyes = [st, r3(worst), reason];

    // exposure
    const face = mf.length && mf[0].luma != null ? mf[0] : null;
    const faceLuma = face ? face.luma : null;
    const lowkey = ec <= th.lowkey_ec, highkey = ec >= th.highkey_ec;
    const relax = lowkey ? 0.7 : 1.0;
    st = OK; reason = "";
    const darkMed = f.median < th.dark_median * relax;
    const noHighlights = f.p98 < th.dark_p98 * relax;
    if (darkMed || noHighlights) {
      const faceOk = faceLuma != null && faceLuma >= th.face_ok_luma * relax;
      if (!faceOk) {
        const severe = f.median < th.dark_reject_median * relax || f.p98 < th.dark_reject_p98 * relax;
        st = severe ? REJECT : CHECK;
        const why = [`median ${f.median}`, `brightest 2% at ${f.p98}`];
        if (faceLuma != null) why.push(`face ${fmt0(faceLuma)}`);
        if (lowkey) why.push(`EC ${signed1(ec)} low-key, relaxed`);
        reason = "underexposed: " + why.join(", ");
      }
    }
    out.dark = [st, f.median, reason];

    st = OK; reason = "";
    const hk = highkey ? 1.4 : 1.0;
    const faceClip = face ? (face.clip === undefined ? null : face.clip) : null;
    if (faceClip != null && faceClip > th.face_clip_check * hk) {
      st = faceClip > th.face_clip_reject * hk ? REJECT : CHECK;
      reason = `face highlights clipped (${fmt0(faceClip * 100)}% of the face)`;
    } else if (faceLuma != null && faceLuma > th.face_blown_luma) {
      st = REJECT; reason = `main face blown out (luma ${fmt0(faceLuma)})`;
    } else if (f.clip_hi > th.bright_clip * hk && f.median > 150) {
      const faceFine = faceLuma != null && faceClip != null && faceClip < th.face_clip_check / 2;
      if (!(faceFine && f.clip_hi < th.bright_clip_reject * hk)) {
        st = f.clip_hi > th.bright_clip_reject * hk && !faceFine ? REJECT : CHECK;
        reason = `${fmt0(f.clip_hi * 100)}% of the frame clipped, median ${f.median}` +
          (highkey ? ` (EC ${signed1(ec)} high-key, relaxed)` : "");
      }
    }
    out.bright = [st, r4(faceClip != null ? faceClip : f.clip_hi), reason];

    // accidental
    st = OK; reason = "";
    if (!faces.length && f.std < th.blank_std) {
      st = REJECT; reason = `almost no content (contrast ${pyFixed(f.std, 1)}) - lens cap / blank frame`;
    } else if (!faces.length && f.edge_density < th.blank_edges && out.dark[0] === OK) {
      st = f.std < 20 ? REJECT : CHECK;
      reason = `no subject, almost no edges (${fmt2(f.edge_density * 100)}%) - sky / ground / misfire?`;
    }
    out.accidental = [st, r5(f.edge_density), reason];

    if (out.accidental[0] === REJECT && f.std < th.blank_std) {
      for (const k of ["blur", "missed_focus", "dark", "bright"]) out[k] = [OK, out[k][1], ""];
    }
    const ordered = {};
    for (const k of WC.CHECKS) ordered[k] = out[k];
    return ordered;
  };

  WC.qualityScore = function (f, verdicts, th) {
    const sf = subjectFocus(f, th);
    const sSharp = 0.5 * Math.min(1.0, sf.sharp / 35.0) + 0.5 * Math.min(1.0, sf.energy / 1.5);
    const mf = mainFaces(f, th);
    const judged = mf.filter((x) => x.blink != null).map((x) => x.blink);
    const sEyes = judged.length ? 1.0 - Math.max(...judged) : 0.7;
    const quals = mf.filter((x) => x.quality != null).map((x) => x.quality);
    const sFace = quals.length ? quals.reduce((a, b) => a + b, 0) / quals.length : 0.5;
    let sExpo = 1.0;
    for (const k of ["dark", "bright"]) sExpo -= { ok: 0, check: 0.3, reject: 0.6 }[verdicts[k][0]];
    const score = 0.45 * sSharp + 0.25 * sEyes + 0.15 * sFace + 0.15 * sExpo;
    const worst = Math.max(...Object.values(verdicts).map((v) => RANK[v[0]]));
    return r4(score - 0.5 * worst);
  };

  WC.summarise = function (verdicts) {
    const worst = Math.max(...Object.values(verdicts).map((v) => RANK[v[0]]));
    const status = [OK, CHECK, REJECT][worst];
    const flagged = WC.CHECKS.filter((k) => verdicts[k][0] !== OK);
    let primary = "";
    for (const level of [REJECT, CHECK]) {
      for (const k of WC.CHECKS) if (verdicts[k][0] === level) { primary = k; break; }
      if (primary) break;
    }
    return [status, flagged, primary];
  };

  // ------------------------------------------------------------------ bursts (bursts.py)
  WC.hamming = function (a, b) {
    let n = 0;
    for (let i = 0; i < 16; i += 4) {
      let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
      while (x) { n += x & 1; x >>>= 1; }
    }
    return n;
  };

  const pyCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-point order, like Python str comparison

  WC.groupBursts = function (items, cfg) {
    const byCam = new Map();
    for (const it of items) {
      const cam = (it.meta || {}).camera || "?";
      if (!byCam.has(cam)) byCam.set(cam, []);
      byCam.get(cam).push(it);
    }
    const groups = [];
    for (const camItems of byCam.values()) {
      const hasTime = camItems.every((x) => (x.meta || {}).time_source === "exif");
      camItems.sort((x, y) => (hasTime ? x.meta.time - y.meta.time : 0) || pyCmp(x.name, y.name));
      let cur = [];
      for (const it of camItems) {
        if (!cur.length) { cur = [it]; continue; }
        const prev = cur[cur.length - 1], first = cur[0];
        const dPrev = WC.hamming(it.phash, prev.phash), dFirst = WC.hamming(it.phash, first.phash);
        let same;
        if (hasTime) {
          const gap = it.meta.time - prev.meta.time, span = it.meta.time - first.meta.time;
          const limit = gap < 0.7 ? cfg.hash_dist_tight : cfg.hash_dist;
          same = gap <= cfg.max_gap_s && span <= cfg.max_span_s && (dPrev <= limit || dFirst <= limit);
        } else {
          same = dPrev <= cfg.no_time_hash_dist;
        }
        if (same) cur.push(it); else { groups.push(cur); cur = [it]; }
      }
      if (cur.length) groups.push(cur);
    }
    groups.sort((g, h) => ((g[0].meta.time || 0) - (h[0].meta.time || 0)) || pyCmp(g[0].name, h[0].name));
    return groups;
  };

  // ------------------------------------------------------------------ all photos (pipeline.decide_all)
  /** feats: feature dicts (from analyze). overrides: Map/obj name -> keep|reject|check. Returns ordered results. */
  WC.decideAll = function (feats, cfg, overrides = {}) {
    const th = cfg.thresholds;
    const ov = overrides instanceof Map ? overrides : new Map(Object.entries(overrides));
    const good = feats.filter((f) => !f.error);
    const results = new Map();
    for (const f of good) {
      const v = WC.evaluate(f, th);
      const [status, reasons, primary] = WC.summarise(v);
      const sf = subjectFocus(f, th);
      const mf = mainFaces(f, th);
      const blinks = mf.filter((x) => x.blink != null).map((x) => x.blink);
      const quals = mf.filter((x) => x.quality != null).map((x) => x.quality);
      results.set(f.id, {
        id: f.id, path: f.path, name: f.name, status, auto_status: status, reasons, primary, verdicts: v,
        quality: WC.qualityScore(f, v, th), sharp: Math.round(sf.sharp * 10) / 10, sharp_src: sf.where,
        n_faces: f.n_faces, n_main: mf.length, max_blink: blinks.length ? r3(Math.max(...blinks)) : null,
        face_quality: quals.length ? r3(quals.reduce((a, b) => a + b, 0) / quals.length) : null,
        f, override: null,
      });
    }
    const groups = WC.groupBursts(good, cfg.bursts);
    groups.forEach((g, i) => {
      const rs = g.map((x) => results.get(x.id));
      const pool = rs.filter((r) => r.status !== REJECT);
      const cand = pool.length ? pool : rs;
      let best = cand[0];
      for (const r of cand) if (r.quality > best.quality) best = r; // max(): first of equal maxima wins
      // keep N best per burst (web setting, 1-5; 1 = the desktop behaviour): the keeper plus the next best
      const nKeep = Math.max(1, Math.min(5, Math.round((cfg.bursts && cfg.bursts.keep) || 1)));
      const kept = new Set([best]);
      if (nKeep > 1) for (const r of cand.filter((x) => x !== best).sort((a, b) => b.quality - a.quality)) {
        if (kept.size >= nKeep) break; kept.add(r);
      }
      for (const r of rs) {
        r.burst = i + 1; r.burst_size = rs.length; r.keeper = best.id;
        r.role = rs.length === 1 ? "single" : (kept.has(r) ? "best" : "alternate");
      }
    });
    for (const r of results.values()) {
      const dec = ov.get(r.name);
      if (dec) { r.override = dec; r.status = { keep: OK, reject: REJECT, check: CHECK }[dec]; }
    }
    const errs = feats.filter((f) => f.error).map((f) => ({
      id: f.id, path: f.path, name: f.name, status: "error", error: f.error, reasons: [], role: "single",
      primary: "", burst: 0, burst_size: 1, keeper: f.id, quality: 0, verdicts: {}, f,
    }));
    const ordered = [...results.values()].sort((a, b) =>
      (a.burst - b.burst) || ((a.f.meta.time || 0) - (b.f.meta.time || 0)) || pyCmp(a.name, b.name));
    return ordered.concat(errs);
  };

  // ------------------------------------------------------------------ XMP plan (xmp.py plan)
  WC.KEYWORD_ROOT = "Culling";
  WC.OUR_KEYWORDS = ["Reject", "Check", "Best of burst", "Alternate", ...Object.values(WC.LABELS)]
    .map((v) => `${WC.KEYWORD_ROOT}|${v}`);
  WC.OUR_LABELS = ["Second", "Yellow"];

  WC.plan = function (r, out) {
    let rating;
    if (r.status === REJECT) rating = -1;
    else if (r.role === "best" || (r.role === "single" && out.star_singles !== false)) rating = out.star_best || 3;
    else rating = 0;
    const flagged = r.status === CHECK;
    const label = flagged ? (out.check_label || "Second") : "";
    const kws = [];
    if (out.keywords !== false) {
      if (r.status === REJECT) kws.push(`${WC.KEYWORD_ROOT}|Reject`);
      else if (r.status === CHECK) kws.push(`${WC.KEYWORD_ROOT}|Check`);
      if (r.role === "best") kws.push(`${WC.KEYWORD_ROOT}|Best of burst`);
      else if (r.role === "alternate") kws.push(`${WC.KEYWORD_ROOT}|Alternate`);
      if (r.override !== "keep") for (const k of r.reasons) kws.push(`${WC.KEYWORD_ROOT}|${WC.LABELS[k]}`);
    }
    return { rating, label, keywords: [...new Set(kws)] };
  };

  // ------------------------------------------------------------------ CSV (results.csv, same columns as desktop)
  WC.CSV_FIELDS = ["file", "status", "role", "primary_reason", "reasons", "burst", "burst_size", "keeper",
    "quality", "subject_sharpness", "sharpness_source", "global_sharpness", "tile_sharpness", "directional_spread",
    "faces", "main_faces", "max_blink", "face_quality", "median_luma", "clipped_highlights", "clipped_shadows",
    "edge_density", ...WC.CHECKS.map((c) => `${c}_status`), ...WC.CHECKS.map((c) => `${c}_score`),
    "capture_time", "camera", "iso", "shutter", "aperture", "exposure_comp", "override", "error"];

  function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  /** results.csv with the desktop tool's columns (cull calibrate / cull apply read it) */
  WC.csvRows = function (results) {
    const byId = new Map(results.map((r) => [r.id, r]));
    const lines = [WC.CSV_FIELDS.join(",")];
    for (const r of results) {
      const f = r.f || {}, m = f.meta || {};
      const row = { file: r.name, status: r.status, role: r.role, error: r.error || "",
        primary_reason: WC.LABELS[r.primary] || "", burst: r.burst, burst_size: r.burst_size,
        keeper: byId.has(r.keeper) ? byId.get(r.keeper).name : "", override: r.override || "" };
      if (!r.error) {
        Object.assign(row, {
          reasons: r.reasons.map((k) => r.verdicts[k][2]).join(" | "), quality: r.quality,
          subject_sharpness: r.sharp, sharpness_source: r.sharp_src, global_sharpness: f.global_sharp,
          tile_sharpness: f.tile_sharp, directional_spread: f.spread, faces: f.n_faces, main_faces: r.n_main,
          max_blink: r.max_blink, face_quality: r.face_quality, median_luma: f.median, clipped_highlights: f.clip_hi,
          clipped_shadows: f.clip_lo, edge_density: f.edge_density, capture_time: m.time_text || "",
          camera: m.camera || "", iso: m.iso, aperture: m.fnumber,
          shutter: m.exposure_time && m.exposure_time < 1 ? `1/${Math.round(1 / m.exposure_time)}` : m.exposure_time,
          exposure_comp: m.ec,
        });
        for (const c of WC.CHECKS) { row[`${c}_status`] = r.verdicts[c][0]; row[`${c}_score`] = r.verdicts[c][1]; }
      }
      lines.push(WC.CSV_FIELDS.map((k) => csvCell(row[k])).join(","));
    }
    return lines.join("\n") + "\n";
  };

  /** overrides.csv the desktop tool reads (`cull apply FOLDER --overrides overrides.csv`). */
  WC.overridesCsv = function (overrides) {
    const lines = ["file,decision"];
    for (const [name, dec] of overrides) lines.push(`${csvCell(name)},${dec}`);
    return lines.join("\n") + "\n";
  };

  if (typeof module === "object" && module && module.exports && typeof window === "undefined" &&
      typeof importScripts === "undefined") module.exports = WC;
})(typeof self !== "undefined" ? self : globalThis);
