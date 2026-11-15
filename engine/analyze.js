/* Wedding Cull web: per-photo measurements (port of wedding_cull/analyze.py) on OpenCV.js.
   analyzeImage(cv, rgba, faces, meta) takes the photo decoded as an RGBA cv.Mat (long edge <= 2048, oriented)
   and the faces found by MediaPipe on that image, and returns the same feature dict as the desktop tool. */
(function (root) {
  "use strict";
  const WC = root.WC = root.WC || {};
  WC.FEATURE_VERSION = "web-5";
  WC.ANALYSIS_EDGE = 2048;
  const METRIC_EDGE = 1024, FACE_MAX = 512, TILE_GRID = 6;

  /** Python's round(): half to even (matters for image sizes like 1023.5). */
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  WC.pyRound = pyRound;
  const rnd = (x, d) => { const k = Math.pow(10, d); return Math.round(x * k) / k; };

  const KERNELS = [
    [0, 0, 0, 1, -2, 1, 0, 0, 0],
    [0, 1, 0, 0, -2, 0, 0, 1, 0],
    [0.5, 0, 0, 0, -1, 0, 0, 0, 0.5],
    [0, 0, 0.5, 0, -1, 0, 0.5, 0, 0],
  ];

  /** variance of a float32 Mat (or a rectangle of it), population variance like numpy .var() */
  function variance(m, x0 = 0, y0 = 0, w = m.cols, h = m.rows) {
    const d = m.data32F, cols = m.cols;
    let s = 0, s2 = 0;
    const n = w * h;
    if (n <= 0) return NaN;
    for (let y = y0; y < y0 + h; y++) {
      let o = y * cols + x0;
      for (let x = 0; x < w; x++, o++) { const v = d[o]; s += v; s2 += v * v; }
    }
    const mean = s / n;
    return Math.max(0, s2 / n - mean * mean);
  }

  function withMats(cv, fn) {
    const mats = [];
    const M = (m) => { mats.push(m); return m; };
    try { return fn(M); } finally { for (const m of mats) if (!m.isDeleted()) m.delete(); }
  }

  function kernels(cv, M) {
    return KERNELS.map((k) => M(cv.matFromArray(3, 3, cv.CV_32F, k)));
  }

  function responses(cv, M, g, ks) {
    return ks.map((k) => {
      const r = M(new cv.Mat());
      cv.filter2D(g, r, cv.CV_32F, k, new cv.Point(-1, -1), 0, cv.BORDER_DEFAULT);
      return r;
    });
  }

  function prep(cv, M, gray) {
    const f = M(new cv.Mat());
    gray.convertTo(f, cv.CV_32F);
    const g = M(new cv.Mat());
    cv.GaussianBlur(f, g, new cv.Size(3, 3), 0.5, 0, cv.BORDER_DEFAULT);
    return g;
  }

  function halfOf(cv, M, g) {
    const h = M(new cv.Mat());
    cv.resize(g, h, new cv.Size(0, 0), 0.5, 0.5, cv.INTER_AREA);
    return h;
  }

  /** multi-scale directional Laplacian ratio x100 -> [sharpness, coarse energy, directional spread] */
  function sharpnessRatio(cv, gray) {
    return withMats(cv, (M) => {
      const ks = kernels(cv, M);
      const g = prep(cv, M, gray), half = halfOf(cv, M, g);
      const fine = responses(cv, M, g, ks).map((r) => variance(r));
      const coarse = responses(cv, M, half, ks).map((r) => variance(r));
      const ratios = fine.map((f, i) => f / Math.max(coarse[i], 1e-3));
      const mn = Math.min(...ratios);
      return [100 * mn, coarse.reduce((a, b) => a + b, 0), Math.max(...ratios) / Math.max(mn, 1e-6)];
    });
  }

  /** contrast-normalised fine-scale energy along the weakest direction, x100 */
  function detailEnergy(cv, gray, canon = 256) {
    return withMats(cv, (M) => {
      let src = gray;
      if (canon) {
        src = M(new cv.Mat());
        cv.resize(gray, src, new cv.Size(canon, canon), 0, 0, gray.rows > canon ? cv.INTER_AREA : cv.INTER_CUBIC);
      }
      const ks = kernels(cv, M);
      const g = prep(cv, M, src);
      const contrast = variance(g);
      if (contrast < 1) return 0.0;
      return 100 * Math.min(...responses(cv, M, g, ks).map((r) => variance(r))) / contrast;
    });
  }

  /** orthonormal 2-D DCT-II of a 32x32 block (= cv2.dct), top-left 8x8 -> 64-bit hash as 16 hex digits */
  const DCT_N = 32;
  let DCT_C = null;
  function dctTable() {
    if (DCT_C) return DCT_C;
    DCT_C = new Float64Array(8 * DCT_N);
    for (let u = 0; u < 8; u++) {
      const a = u === 0 ? Math.sqrt(1 / DCT_N) : Math.sqrt(2 / DCT_N);
      for (let x = 0; x < DCT_N; x++) DCT_C[u * DCT_N + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
    }
    return DCT_C;
  }
  function phash(cv, gray) {
    return withMats(cv, (M) => {
      const small = M(new cv.Mat());
      cv.resize(gray, small, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);
      const px = small.data, C = dctTable();
      const tmp = new Float64Array(8 * DCT_N); // rows of the DCT along x: tmp[v][y]... computed as u over x first
      for (let u = 0; u < 8; u++) for (let y = 0; y < DCT_N; y++) {
        let s = 0;
        for (let x = 0; x < DCT_N; x++) s += C[u * DCT_N + x] * px[y * DCT_N + x];
        tmp[u * DCT_N + y] = s;
      }
      const d = new Float64Array(64); // d[v*8+u] = row v (y frequency), column u (x frequency)
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let y = 0; y < DCT_N; y++) s += C[v * DCT_N + y] * tmp[u * DCT_N + y];
        d[v * 8 + u] = Math.fround(s); // cv2.dct works in float32
      }
      const rest = Array.from(d.slice(1)).sort((a, b) => a - b);
      const med = rest[(rest.length - 1) / 2]; // 63 values -> the middle one (np.median)
      let hex = "";
      for (let i = 0; i < 64; i += 4) {
        let nib = 0;
        for (let j = 0; j < 4; j++) nib = (nib << 1) | (d[i + j] > med ? 1 : 0);
        hex += nib.toString(16);
      }
      return hex;
    });
  }
  WC.phash = phash;

  function rgbMaxClipFraction(rgba, x0, y0, w, h, thr = 250) {
    const d = rgba.data, cols = rgba.cols;
    let n = 0;
    for (let y = y0; y < y0 + h; y++) {
      let o = (y * cols + x0) * 4;
      for (let x = 0; x < w; x++, o += 4) if (d[o] >= thr || d[o + 1] >= thr || d[o + 2] >= thr) n++;
    }
    return w * h ? n / (w * h) : 0;
  }

  function meanU8(m, x0 = 0, y0 = 0, w = m.cols, h = m.rows) {
    const d = m.data, cols = m.cols;
    let s = 0;
    for (let y = y0; y < y0 + h; y++) { let o = y * cols + x0; for (let x = 0; x < w; x++) s += d[o++]; }
    return s / (w * h);
  }

  /**
   * rgba: cv.Mat CV_8UC4 (oriented, long edge <= 2048). faces: [{x, y, w, h, blink}] in pixels of that image
   * (MediaPipe landmark extents). meta: capture metadata. Returns the feature dict (without id/path/name).
   */
  WC.analyzeImage = function (cv, rgba, faces, meta) {
    return withMats(cv, (M) => {
      const H = rgba.rows, W = rgba.cols;
      const grayFull = M(new cv.Mat());
      cv.cvtColor(rgba, grayFull, cv.COLOR_RGBA2GRAY);
      const s = METRIC_EDGE / Math.max(H, W);
      let gray = grayFull, smallRgba = rgba;
      if (s < 1) {
        const size = new cv.Size(pyRound(W * s), pyRound(H * s));
        gray = M(new cv.Mat()); cv.resize(grayFull, gray, size, 0, 0, cv.INTER_AREA);
        smallRgba = M(new cv.Mat()); cv.resize(rgba, smallRgba, size, 0, 0, cv.INTER_AREA);
      }
      const h = gray.rows, w = gray.cols;

      // sharpness tiles; "subject" = the 3 most detailed tiles
      const ks = kernels(cv, M);
      const g = prep(cv, M, gray), half = halfOf(cv, M, g);
      const fineR = responses(cv, M, g, ks), coarseR = responses(cv, M, half, ks);
      let globalSharp = null;
      if (cv.Laplacian) {
        const lap = M(new cv.Mat());
        cv.Laplacian(gray, lap, cv.CV_32F, 3, 1, 0, cv.BORDER_DEFAULT);
        globalSharp = variance(lap);
      }
      const th = Math.floor(h / TILE_GRID), tw = Math.floor(w / TILE_GRID);
      const tiles = [];
      for (let r = 0; r < TILE_GRID; r++) for (let c = 0; c < TILE_GRID; c++) {
        const fv = fineR.map((x) => variance(x, c * tw, r * th, tw, th));
        const cy0 = Math.floor(r * th / 2), cy1 = Math.floor((r + 1) * th / 2);
        const cx0 = Math.floor(c * tw / 2), cx1 = Math.floor((c + 1) * tw / 2);
        const cvv = coarseR.map((x) => variance(x, cx0, cy0, Math.min(cx1, x.cols) - cx0, Math.min(cy1, x.rows) - cy0));
        const ratios = fv.map((a, i) => a / Math.max(cvv[i], 1e-3));
        const contrast = variance(g, c * tw, r * th, tw, th);
        const energy = contrast >= 1 ? 100 * Math.min(...fv) / contrast : 0.0;
        const mn = Math.min(...ratios);
        tiles.push([cvv.reduce((a, b) => a + b, 0), 100 * mn, Math.max(...ratios) / Math.max(mn, 1e-6), [r, c], energy]);
      }
      tiles.sort((a, b) => b[0] - a[0]);
      const top = tiles.slice(0, 3);
      const med3 = (arr) => arr.slice().sort((a, b) => a - b)[1];
      const tileSharp = med3(top.map((t) => t[1]));
      const bestTile = top[0][3];
      const spread = med3(top.map((t) => t[2]));
      const tileEnergy = med3(top.map((t) => t[4]));
      const tileSharpMax = Math.max(...tiles.filter((t) => t[0] > 0.05 * top[0][0]).map((t) => t[1]));

      // exposure on the 1024 px image
      const gd = gray.data, npx = gd.length;
      const hist = new Float64Array(256);
      let sum = 0, sum2 = 0, lo = 0;
      for (let i = 0; i < npx; i++) { const v = gd[i]; hist[v]++; sum += v; sum2 += v * v; if (v <= 4) lo++; }
      const cdf = new Float64Array(256);
      let acc = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc / npx; }
      const pct = (q) => { for (let i = 0; i < 256; i++) if (cdf[i] >= q) return i; return 256; };
      const mean = sum / npx;
      const std = Math.sqrt(Math.max(0, sum2 / npx - mean * mean));
      const clipHi = rgbMaxClipFraction(smallRgba, 0, 0, w, h);
      const edges = M(new cv.Mat());
      cv.Canny(gray, edges, 60, 150, 3, false);
      const edgeDensity = cv.countNonZero(edges) / npx;

      // faces (boxes from MediaPipe on this image)
      let fs = (faces || []).map((f) => Object.assign({}, f)).filter((f) => f.h >= 24);
      fs.sort((a, b) => b.h - a.h);
      for (const f of fs) {
        const x0 = Math.trunc(Math.max(0, f.x)), y0 = Math.trunc(Math.max(0, f.y));
        const x1 = Math.trunc(Math.min(W, f.x + f.w)), y1 = Math.trunc(Math.min(H, f.y + f.h));
        const cw = x1 - x0, ch = y1 - y0;
        const mpBlink = f.blink;
        delete f.blink;
        f.mp_blink = mpBlink == null ? null : mpBlink;
        if (cw <= 0 || ch <= 0 || cw * ch < 100) { f.sharp = null; f.luma = null; continue; }
        const crop = grayFull.roi(new cv.Rect(x0, y0, cw, ch));
        M(crop);
        let cropM = crop;
        if (ch > FACE_MAX) {
          const k = FACE_MAX / ch;
          cropM = M(new cv.Mat());
          cv.resize(crop, cropM, new cv.Size(0, 0), k, k, cv.INTER_AREA);
        }
        const cropC = M(crop.clone()); // continuous copy: .data of an ROI is not row-contiguous
        const cropMC = cropM === crop ? cropC : cropM;
        const sr = sharpnessRatio(cv, cropMC);
        f.sharp = sr[0]; f.spread = sr[2];
        f.energy = detailEnergy(cv, cropC);
        f.clip = rgbMaxClipFraction(rgba, x0, y0, cw, ch);
        f.luma = meanU8(cropC);
        f.blink = null;
      }
      let faceTile = null;
      if (fs.length) {
        const biggest = fs[0].h;
        for (const f of fs) {
          f.main = f.h >= 0.45 * biggest && f.h >= 40;
          if (f.main && f.h >= 50 && f.luma !== null) f.blink = f.mp_blink;
        }
        const f0 = fs[0];
        const cx = (f0.x + f0.w / 2) * s, cy = (f0.y + f0.h / 2) * s;
        faceTile = [Math.min(TILE_GRID - 1, Math.floor(cy / th)), Math.min(TILE_GRID - 1, Math.floor(cx / tw))];
      }
      const roundFace = (f) => {
        const o = {};
        for (const [k, v] of Object.entries(f)) o[k] = typeof v === "number" && !Number.isInteger(v) ? rnd(v, 4) : v;
        return o;
      };
      return {
        w: W, h: H,
        global_sharp: globalSharp === null ? null : rnd(globalSharp, 2), tile_sharp: rnd(tileSharp, 2),
        tile_sharp_max: rnd(tileSharpMax, 2), tile_energy: rnd(tileEnergy, 3),
        best_tile: bestTile, face_tile: faceTile, spread: rnd(spread, 3),
        median: pct(0.5), mean: rnd(mean, 1), p02: pct(0.02), p98: pct(0.98),
        std: rnd(std, 2), clip_hi: rnd(clipHi, 4), clip_lo: rnd(lo / npx, 4),
        edge_density: rnd(edgeDensity, 5),
        phash: phash(cv, gray),
        faces: fs.slice(0, 12).map(roundFace), n_faces: fs.length,
        meta,
      };
    });
  };

  if (typeof module === "object" && module && module.exports && typeof window === "undefined" &&
      typeof importScripts === "undefined") module.exports = WC;
})(typeof self !== "undefined" ? self : globalThis);
