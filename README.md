# Cartoon Generator AI

A browser-based cartoon script & concept generator powered by **Gemma 2 2B** via [WebLLM](https://webllm.mlc.ai). The model runs **entirely in your browser** — no server, no API key, no cost.

## Features

- 🎬 Generate detailed cartoon concepts, character bios, episode outlines, and scene breakdowns
- 🎨 Choose from 6 visual styles: Anime, Pixar/Disney 3D, Retro 8-Bit, Comic Book, Manga, Watercolor
- 🎭 Set the tone: Adventurous, Comedic, Dramatic, Heartwarming, Dark, Educational
- 📺 Stream output live as the AI generates
- ✂️ Copy results with one click
- 🎲 Random idea generator for inspiration

## Usage

### Option 1 — Open directly (requires a local web server for ES modules)

```bash
# Using Python
python3 -m http.server 8080
# Then open http://localhost:8080
```

### Option 2 — VS Code Live Server

Install the **Live Server** extension and click "Go Live".

### Option 3 — npx serve

```bash
npx serve .
```

> **Note:** On first load the app downloads the Gemma 2 2B model (~1.5 GB). This is cached by your browser so subsequent loads are instant. Your browser must support **WebGPU** (Chrome 113+ / Edge 113+).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main page & UI |
| `style.css` | Dark-theme styling |
| `app.js` | WebLLM engine setup, prompt building, streaming output |

## How It Works

1. On page load `app.js` calls `CreateMLCEngine("gemma-2-2b-it-q4f16_1-MLC")` from the `@mlc-ai/web-llm` package (loaded via ESM CDN).
2. The model weights are downloaded from Hugging Face and cached in the browser's Cache API.
3. Inference runs via WebGPU — no data ever leaves your device.
4. A structured system prompt instructs Gemma to act as a cartoon-production AI.
