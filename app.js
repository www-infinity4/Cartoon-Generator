// Cartoon Generator – app.js
// Uses WebLLM (https://webllm.mlc.ai) with Gemma 2 2B running entirely in the browser.

import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

// ── Config ────────────────────────────────────────────────────────────────────
const MODEL_ID   = "gemma-2-2b-it-q4f16_1-MLC";
const MODEL_SIZE = "~1.5 GB";

const STYLE_PROMPTS = {
  anime:     "anime style, cel-shaded, vibrant colors, big expressive eyes, speed lines",
  pixar:     "Pixar/Disney 3D animation style, warm lighting, expressive characters",
  "8bit":    "retro 8-bit pixel art style, limited color palette, chunky pixels",
  comic:     "comic book style, bold ink outlines, halftone dots, dynamic panel layout",
  manga:     "black-and-white manga style, detailed line work, screentone shading",
  watercolor:"watercolor illustration style, soft edges, pastel washes, storybook feel",
};

// ── State ─────────────────────────────────────────────────────────────────────
let engine = null;
let generating = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot  = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statusBar  = document.getElementById("status-bar");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");

const generateBtn = document.getElementById("generate-btn");
const stopBtn     = document.getElementById("stop-btn");
const copyBtn     = document.getElementById("copy-btn");
const clearBtn    = document.getElementById("clear-btn");

const promptInput   = document.getElementById("prompt");
const styleSelect   = document.getElementById("style");
const episodesInput = document.getElementById("episodes");
const toneSelect    = document.getElementById("tone");
const outputEl      = document.getElementById("output-text");

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state, msg) {
  statusBar.className = state; // '', 'loading', 'ready', 'error'
  statusText.textContent = msg;
}

function setProgress(pct) {
  if (pct == null) {
    progressWrap.classList.remove("visible");
    progressFill.style.width = "0%";
  } else {
    progressWrap.classList.add("visible");
    progressFill.style.width = `${Math.min(100, pct)}%`;
  }
}

// ── Output helpers ────────────────────────────────────────────────────────────
function setOutput(text, placeholder = false) {
  outputEl.textContent = text;
  outputEl.className = placeholder ? "placeholder" : "";
}

function appendOutput(chunk) {
  // Remove cursor if present, append, re-add cursor
  const existing = outputEl.innerHTML.replace(/<span class="cursor"><\/span>$/, "");
  outputEl.innerHTML = existing + escapeHtml(chunk) + '<span class="cursor"></span>';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function removeCursor() {
  outputEl.innerHTML = outputEl.innerHTML.replace(/<span class="cursor"><\/span>$/, "");
}

// ── Engine initialisation ─────────────────────────────────────────────────────
async function initEngine() {
  setStatus("loading", `Loading Cartoon AI… (first load downloads the model ${MODEL_SIZE})`);
  setProgress(0);
  generateBtn.disabled = true;

  try {
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback(report) {
        const pct = Math.round((report.progress ?? 0) * 100);
        setProgress(pct);
        setStatus("loading", report.text ?? `Loading model… ${pct}%`);
      },
    });
    setProgress(null);
    setStatus("ready", `Cartoon AI ready — ${MODEL_ID} running in your browser`);
    generateBtn.disabled = false;
  } catch (err) {
    setProgress(null);
    setStatus("error", `Failed to load model: ${err.message}`);
    console.error(err);
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return (
    "You are the Cartoon Generator AI — a creative AI that writes detailed cartoon " +
    "scripts, scene descriptions, character bios, and episode outlines. " +
    "Your output is vivid, imaginative, and ready for animation production. " +
    "Always structure your output clearly with headings like 'Title', 'Characters', " +
    "'Setting', 'Episode Outline', and 'Scene Breakdown'."
  );
}

function buildUserPrompt(idea, style, episodes, tone) {
  const styleDesc = STYLE_PROMPTS[style] || style;
  const eps = parseInt(episodes, 10) || 1;
  return (
    `Create a cartoon concept based on the following idea:\n"${idea}"\n\n` +
    `Visual style: ${styleDesc}\n` +
    `Number of episodes to outline: ${eps}\n` +
    `Tone: ${tone}\n\n` +
    `Please include:\n` +
    `1. Show title and tagline\n` +
    `2. Main characters (name, appearance, personality)\n` +
    `3. World/Setting description\n` +
    `4. Episode outline(s) with scene breakdown\n` +
    `5. Key visual moments suitable for animation\n`
  );
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function generate() {
  if (!engine || generating) return;

  const idea = promptInput.value.trim();
  if (!idea) {
    promptInput.focus();
    setStatus("error", "Please enter a cartoon idea first.");
    return;
  }

  generating = true;
  generateBtn.disabled = true;
  stopBtn.disabled = false;
  copyBtn.disabled = true;
  setStatus("loading", "Generating cartoon…");

  const messages = [
    { role: "system",  content: buildSystemPrompt() },
    { role: "user",    content: buildUserPrompt(idea, styleSelect.value, episodesInput.value, toneSelect.value) },
  ];

  outputEl.innerHTML = '<span class="cursor"></span>';
  outputEl.className = "";

  try {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.8,
      max_tokens: 1200,
    });

    for await (const chunk of stream) {
      if (!generating) break; // stop requested
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) appendOutput(delta);
    }
  } catch (err) {
    if (generating) {
      setStatus("error", `Generation error: ${err.message}`);
      console.error(err);
    }
  } finally {
    removeCursor();
    generating = false;
    generateBtn.disabled = false;
    stopBtn.disabled = true;
    copyBtn.disabled = false;
    if (engine) setStatus("ready", "Done — ready for another cartoon!");
  }
}

// ── Button handlers ───────────────────────────────────────────────────────────
generateBtn.addEventListener("click", generate);

stopBtn.addEventListener("click", () => {
  generating = false;
  engine?.interruptGenerate?.();
  stopBtn.disabled = true;
  generateBtn.disabled = false;
  removeCursor();
  setStatus("ready", "Generation stopped.");
});

copyBtn.addEventListener("click", async () => {
  const text = outputEl.innerText;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const orig = copyBtn.textContent;
  copyBtn.textContent = "✅ Copied!";
  setTimeout(() => { copyBtn.textContent = orig; }, 1800);
});

clearBtn.addEventListener("click", () => {
  setOutput("Your generated cartoon will appear here…", true);
  copyBtn.disabled = true;
});

// Example ideas for inspiration
const EXAMPLES = [
  "A group of misfit robots living in a post-apocalyptic junkyard who dream of becoming musicians",
  "A young wizard cat who accidentally enrolls in a school for humans",
  "Sentient office supplies staging a rebellion against their corporate overlords",
  "An underwater city ruled by a council of wise sea turtles and a chaotic dolphin mayor",
  "A time-traveling food truck that visits historical events to feed hungry heroes",
];

document.getElementById("example-btn").addEventListener("click", () => {
  promptInput.value = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
  promptInput.focus();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
setOutput("Your generated cartoon will appear here…", true);
initEngine();
