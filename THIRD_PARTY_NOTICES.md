# Third-party software and models

Bundled unchanged so the site runs offline from one origin and never calls another server.

| Path | What | Version | License |
|---|---|---|---|
| `vendor/opencv/opencv.js` | OpenCV.js (build from [`@techstark/opencv-js`](https://www.npmjs.com/package/@techstark/opencv-js)) | 4.10.0-release.1 | Apache-2.0 (`vendor/opencv/LICENSE`) |
| `vendor/mediapipe/` | MediaPipe Tasks Vision ([`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision)), `vision_bundle.cjs` renamed to `.js` | 0.10.21 | Apache-2.0 (`vendor/mediapipe/LICENSE`) |
| `models/face_landmarker.task` | MediaPipe Face Landmarker model (float16, v1) | 1 | Apache-2.0 |
| `models/face_detection_yunet_2023mar.onnx` | YuNet face detector, [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | 2023mar | MIT |
| `assets/fonts/pretendard/` | [Pretendard](https://github.com/orioncactus/pretendard) Variable, dynamic subsets (only the parts a page needs are loaded) | 1.3.9 | SIL OFL 1.1 (`assets/fonts/pretendard/LICENSE.txt`) |
| `assets/fonts/archivo-var.woff2` | [Archivo](https://github.com/Omnibus-Type/Archivo) variable (weight + width), Latin subset via [`@fontsource-variable/archivo`](https://www.npmjs.com/package/@fontsource-variable/archivo) | 5.2.8 | SIL OFL 1.1 (`assets/fonts/archivo-LICENSE.txt`) |
