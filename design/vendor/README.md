# Vendored for Linear Design

Each piece loads only when someone first uses the feature that needs it, and is
served from this origin, so a photo never leaves the machine (the page's CSP
names no remote host for scripts, models or fonts).

| File | Source | License |
|---|---|---|
| `ort/ort.wasm.min.js`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.wasm` | npm `onnxruntime-web@1.30.0` (`dist/`), source-map comment removed | MIT © Microsoft Corporation |
| `models/u2netp.onnx` | U²-Net-p (Qin et al., github.com/xuebinqin/U-2-Net), ONNX export from huggingface.co/BritishWerewolf/U-2-Netp — byte-identical to rembg's `u2netp.onnx` | Apache-2.0 |
| `models/modnet.onnx` | MODNet (Ke et al., github.com/ZHKKKe/MODNet), quantized ONNX from huggingface.co/Xenova/modnet (`onnx/model_quantized.onnx`) | Apache-2.0 |

SHA-256:

```
92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a  models/modnet.onnx
309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8  models/u2netp.onnx
e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b  ort/ort-wasm-simd-threaded.mjs
3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2  ort/ort-wasm-simd-threaded.wasm
7796a15f0a31d9900955c4fc75aaf6890ee7a6beaa30afc10a2587346334fb4a  ort/ort.wasm.min.js
```

## Fonts

`fonts/*.woff2` — 36 Google Fonts families (latin subset) from Fontsource 5.x
(`@fontsource/<family>`), all under the SIL Open Font License 1.1.
`fonts/fonts.css` declares them; the editor loads each face on first use.

## Video export

`mp4/mp4-muxer.js` and `mp4/webm-muxer.js` — from npm `mp4-muxer@5.2.2` and
`webm-muxer@5.1.4` (`build/*.js`), both MIT © Vanilagy (`mp4/LICENSE`). Loaded
only when someone downloads an MP4.

## Photo tools (magic eraser, upscale, grab text)

Run with the same ONNX Runtime as above; loaded by `design/ai-tools.js`.

| File | Source | License |
|---|---|---|
| `models/migan.onnx` | MI-GAN (Sargsyan et al., ICCV 2023, github.com/Picsart-AI-Research/MI-GAN), `migan_pipeline_v2.onnx` from huggingface.co/andraniksargsyan/migan | MIT |
| `models/realesr-general-x4v3.onnx` | Real-ESRGAN general-x4v3 (Wang et al., github.com/xinntao/Real-ESRGAN), ONNX export from huggingface.co/CoderViking/realesr-general-x4v3-onnx | BSD-3-Clause |
| `ocr/tesseract.min.js`, `ocr/worker.min.js` | npm `tesseract.js@7.0.0` (`dist/`), source-map comments removed | Apache-2.0 |
| `ocr/tesseract-core-*.wasm.js` | npm `tesseract.js-core@7.0.0` | Apache-2.0 |
| `ocr/eng.traineddata.gz` | npm `@tesseract.js-data/eng` (`4.0.0_best_int`) | Apache-2.0 |

`ocr/LICENSE` is the Apache-2.0 text.

SHA-256:

```
6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b  models/migan.onnx
1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112  models/realesr-general-x4v3.onnx
45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91  ocr/eng.traineddata.gz
eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680  ocr/tesseract-core-lstm.wasm.js
861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3  ocr/tesseract-core-relaxedsimd-lstm.wasm.js
c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38  ocr/tesseract-core-simd-lstm.wasm.js
6795ee3bde03681e64fa4ddd747c4d9acb388bb9f5e35870fe71dd22feaa1ea1  ocr/tesseract.min.js
f113187fae220d9f895d7bd28d2b94d7640261ae91031b0d6005c2773fcb9861  ocr/worker.min.js
```

## PDF import

Uses pdf.js from `pdf/vendor/` (shared with the PDF tools on this site).
