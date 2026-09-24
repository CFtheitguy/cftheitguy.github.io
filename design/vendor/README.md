# Vendored for Linear Design

Loaded only when someone clicks **Remove background**; served from this origin
so a photo never leaves the machine (the page's CSP names no remote host).

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
