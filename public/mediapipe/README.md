# Local song-detection assets

Live Translate serves MediaPipe and YAMNet from its own HTTPS server so the song detector does not depend on a browser reaching a public CDN during an event.

- `models/yamnet.tflite` is Google's float32 YAMNet AudioClassifier model from `https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite`.
- SHA-256: `4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf`
- The generated `wasm/` directory is copied from the locked `@mediapipe/tasks-audio` npm package before each development or production build.

MediaPipe Tasks is Apache-2.0 licensed. YAMNet is published by Google as part of the MediaPipe Audio Classifier model assets.
