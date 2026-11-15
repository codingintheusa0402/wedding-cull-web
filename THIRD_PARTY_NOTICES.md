# Third-party software and models

Bundled unchanged so the site runs offline from one origin and never calls another server.

| Path | What | Version | License |
|---|---|---|---|
| `vendor/opencv/opencv.js` | OpenCV.js (build from [`@techstark/opencv-js`](https://www.npmjs.com/package/@techstark/opencv-js)) | 4.10.0-release.1 | Apache-2.0 (`vendor/opencv/LICENSE`) |
| `vendor/mediapipe/` | MediaPipe Tasks Vision ([`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision)), `vision_bundle.cjs` renamed to `.js` | 0.10.21 | Apache-2.0 (`vendor/mediapipe/LICENSE`) |
| `models/face_landmarker.task` | MediaPipe Face Landmarker model (float16, v1) | 1 | Apache-2.0 |
| `models/face_detection_yunet_2023mar.onnx` | YuNet face detector, [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | 2023mar | MIT |
