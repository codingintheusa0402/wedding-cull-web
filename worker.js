/* Wedding Cull web worker: one photo in -> features + thumbnail out. Runs entirely on this computer. */
"use strict";
importScripts("vendor/opencv/opencv.js");
importScripts("engine/core.js", "engine/analyze.js", "engine/files.js");
// MediaPipe's bundle is CommonJS: give it a module object to fill
self.module = { exports: {} }; self.exports = self.module.exports;
importScripts("vendor/mediapipe/vision_bundle.js");
const { FaceLandmarker, FilesetResolver } = self.module.exports;

const WC = self.WC;
let cvReady = null, landmarker = null, eyeLandmarker = null, yunet = null, faceError = null;

function waitCv() {
  // OpenCV's Module object is "thenable": never await it directly
  if (!cvReady) cvReady = new Promise((r) => { if (self.cv && self.cv.Mat) r(); else self.cv.onRuntimeInitialized = () => r(); });
  return cvReady;
}

async function init() {
  await waitCv();
  try {
    const fileset = await FilesetResolver.forVisionTasks("vendor/mediapipe/wasm");
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "models/face_landmarker.task", delegate: "CPU" },
      runningMode: "IMAGE", numFaces: 8, outputFaceBlendshapes: true, minFaceDetectionConfidence: 0.4,
    });
    // eyes on one face crop at a time (like the desktop's blink(): crop + 60 % margin, 256 px)
    eyeLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "models/face_landmarker.task", delegate: "CPU" },
      runningMode: "IMAGE", numFaces: 1, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3,
    });
  } catch (e) {
    faceError = String(e && e.message || e); // no WebGL: faces / closed eyes skipped, the rest still works
  }
  try {
    // YuNet (OpenCV Zoo, MIT): finds small faces in full-length shots that MediaPipe's short-range detector misses
    const buf = new Uint8Array(await (await fetch("models/face_detection_yunet_2023mar.onnx")).arrayBuffer());
    self.cv.FS_createDataFile("/", "yunet.onnx", buf, true, false, false);
    yunet = new self.cv.FaceDetectorYN("yunet.onnx", "", new self.cv.Size(320, 320), 0.6, 0.3, 50);
  } catch (e) { yunet = null; }
}

const YUNET_EDGE = 1280, VISION_W = 1.107, VISION_H = 0.785, VISION_DY = 0.085;
function yunetFaces(rgba) {
  const cv = self.cv, W = rgba.cols, H = rgba.rows;
  const s = Math.min(1, YUNET_EDGE / Math.max(W, H));
  const bgr = new cv.Mat(), small = new cv.Mat(), out = new cv.Mat();
  try {
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    cv.resize(bgr, small, new cv.Size(Math.round(W * s), Math.round(H * s)), 0, 0, cv.INTER_AREA);
    yunet.setInputSize(new cv.Size(small.cols, small.rows));
    yunet.detect(small, out);
    const faces = [];
    for (let i = 0; i < out.rows; i++) {
      const d = out.data32F.subarray(i * out.cols, (i + 1) * out.cols);
      // map YuNet's box onto Apple Vision's face box (what the desktop thresholds were tuned on):
      // measured on 44 matched faces: Vision is 1.107x wider, 0.785x taller, centred 0.085 h lower
      const w = d[2] / s, h = d[3] / s, cx = d[0] / s + w / 2, cy = d[1] / s + h / 2 + VISION_DY * h;
      const vw = w * VISION_W, vh = h * VISION_H;
      faces.push({ x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh, conf: d[14], quality: null, yaw: 0.0, blink: null });
    }
    return faces;
  } finally { bgr.delete(); small.delete(); out.delete(); }
}

function cropBlink(rgba, f) {
  const cv = self.cv, W = rgba.cols, H = rgba.rows, m = 0.6;
  const x0 = Math.trunc(Math.max(0, f.x - m * f.w)), y0 = Math.trunc(Math.max(0, f.y - m * f.h));
  const x1 = Math.trunc(Math.min(W, f.x + f.w * (1 + m))), y1 = Math.trunc(Math.min(H, f.y + f.h * (1 + m)));
  if (x1 <= x0 || y1 <= y0) return null;
  const roi = rgba.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)), crop = new cv.Mat();
  try {
    const s = 256 / Math.max(roi.rows, roi.cols);
    cv.resize(roi, crop, new cv.Size(0, 0), s, s, s < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
    const res = eyeLandmarker.detect(new ImageData(new Uint8ClampedArray(crop.data), crop.cols, crop.rows));
    if (!res.faceBlendshapes || !res.faceBlendshapes.length) return null;
    const cats = res.faceBlendshapes[0].categories;
    const sc = (n) => (cats.find((c) => c.categoryName === n) || { score: 0 }).score;
    return (sc("eyeBlinkLeft") + sc("eyeBlinkRight")) / 2;
  } finally { roi.delete(); crop.delete(); }
}
const ready = init();

function detectFaces(imageData) {
  if (!landmarker) return [];
  const res = landmarker.detect(imageData);
  const W = imageData.width, H = imageData.height;
  return res.faceLandmarks.map((lms, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of lms) { const x = p.x * W, y = p.y * H; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cats = (res.faceBlendshapes[i] || { categories: [] }).categories;
    const sc = (n) => (cats.find((c) => c.categoryName === n) || { score: 0 }).score;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, conf: 1.0, quality: null, yaw: 0.0,
      blink: (sc("eyeBlinkLeft") + sc("eyeBlinkRight")) / 2 };
  });
}

/** PIL's draft(): JPEG DCT down-scaling by 1/2, 1/4 or 1/8 while both sides stay >= the requested size */
function draftScale(w, h, edge) {
  const s = Math.min(Math.floor(w / edge), Math.floor(h / edge));
  return [8, 4, 2, 1].find((k) => k <= Math.max(1, s));
}

function rotate(cv, mat, o) {
  const R = { 3: cv.ROTATE_180, 6: cv.ROTATE_90_CLOCKWISE, 8: cv.ROTATE_90_COUNTERCLOCKWISE };
  const out = new cv.Mat();
  if (o === 2) cv.flip(mat, out, 1);
  else if (o === 4) cv.flip(mat, out, 0);
  else if (o === 5 || o === 7) {
    const t = new cv.Mat(); cv.flip(mat, t, 1);
    cv.rotate(t, out, o === 5 ? cv.ROTATE_90_COUNTERCLOCKWISE : cv.ROTATE_90_CLOCKWISE); t.delete();
  } else if (R[o] !== undefined) cv.rotate(mat, out, R[o]);
  else { mat.copyTo(out); }
  mat.delete();
  return out;
}

async function decode(file, isRaw) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = WC.readMeta(bytes, isRaw, file.lastModified);
  let jpeg = bytes, manualOrientation = 1;
  if (isRaw) {
    const emb = WC.largestEmbeddedJpeg(bytes);
    if (!emb) throw new Error("no embedded preview found");
    jpeg = emb.bytes;
    // the preview usually has no orientation of its own: use the RAW's
    if (WC.jpegOrientation(jpeg) === 1) manualOrientation = meta.orientation;
  }
  const size = WC.jpegSize(jpeg);
  if (!size) throw new Error("not a readable JPEG");
  const native = Math.max(size.w, size.h);
  const blob = new Blob([jpeg], { type: "image/jpeg" });
  const k = draftScale(size.w, size.h, WC.ANALYSIS_EDGE);
  let bmp;
  if (k > 1) {
    // the browser applies the JPEG's own orientation; check the result has the shape we asked for
    const ori = isRaw ? WC.jpegOrientation(jpeg) : meta.orientation;
    const swap = ori >= 5;
    const tw = Math.ceil((swap ? size.h : size.w) / k), th = Math.ceil((swap ? size.w : size.h) / k);
    bmp = await createImageBitmap(blob, { resizeWidth: tw, resizeHeight: th, resizeQuality: "high", imageOrientation: "from-image" });
  } else {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  }
  const cv = self.cv;
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  let mat = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const s = WC.ANALYSIS_EDGE / Math.max(mat.rows, mat.cols);
  if (s < 1) {
    const r = new cv.Mat();
    cv.resize(mat, r, new cv.Size(WC.pyRound(mat.cols * s), WC.pyRound(mat.rows * s)), 0, 0, cv.INTER_AREA);
    mat.delete(); mat = r;
  }
  if (manualOrientation !== 1) mat = rotate(cv, mat, manualOrientation);
  return { mat, meta, native };
}

function matToImageData(mat) {
  return new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
}

async function jpegOf(cv, mat, edge, quality) {
  const s = Math.min(1, edge / Math.max(mat.rows, mat.cols));
  let m = mat;
  if (s < 1) { m = new cv.Mat(); cv.resize(mat, m, new cv.Size(WC.pyRound(mat.cols * s), WC.pyRound(mat.rows * s)), 0, 0, cv.INTER_AREA); }
  const c = new OffscreenCanvas(m.cols, m.rows);
  c.getContext("2d").putImageData(matToImageData(m), 0, 0);
  if (m !== mat) m.delete();
  return c.convertToBlob({ type: "image/jpeg", quality });
}

async function analyse(job) {
  await ready;
  const cv = self.cv;
  let d;
  try { d = await decode(job.file, job.isRaw); } catch (e) {
    return { id: job.id, error: `${e.name || "Error"}: ${e.message || e}` };
  }
  try {
    let faces;
    if (yunet) {
      faces = yunetFaces(d.mat).filter((f) => f.h >= 24);
      const big = Math.max(0, ...faces.map((f) => f.h));
      // blink only where the desktop scores it: main faces (>= 45 % of the biggest, >= 50 px)
      if (eyeLandmarker) for (const f of faces) if (f.h >= 0.45 * big && f.h >= 50) f.blink = cropBlink(d.mat, f);
    } else faces = detectFaces(matToImageData(d.mat));
    const f = WC.analyzeImage(cv, d.mat, faces, d.meta);
    f.preview_px = d.native;
    const thumb = await jpegOf(cv, d.mat, job.thumbPx || 480, 0.8);
    return { id: job.id, f, thumb, faceError };
  } catch (e) {
    return { id: job.id, error: `${e.name || "Error"}: ${e.message || e}` };
  } finally { d.mat.delete(); }
}

/** a bigger view for the lightbox */
async function preview(job) {
  await ready;
  const d = await decode(job.file, job.isRaw);
  try { return { id: job.id, blob: await jpegOf(self.cv, d.mat, job.edge || 2048, 0.9) }; } finally { d.mat.delete(); }
}

onmessage = async (e) => {
  const job = e.data;
  try {
    if (job.type === "ping") { await ready; postMessage({ type: "ready", faceError }); return; }
    const out = job.type === "preview" ? await preview(job) : await analyse(job);
    postMessage(Object.assign({ type: job.type, seq: job.seq }, out));
  } catch (err) {
    postMessage({ type: job.type, seq: job.seq, id: job.id, error: String(err && err.message || err) });
  }
};
