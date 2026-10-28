# Avobl — Roadmap

Avobl is a free, local-first AI assistant that:
1. chats, reads images, and fills forms (works today, `chatbot/`),
2. lives inside the **VigilX** website as a floating pill that opens a side panel, can read the page and fill it,
3. runs as a **browser extension** on any site,
4. watches VigilX camera snapshots (one every 10 minutes) and saves insights based on your rules.

---

## 1. Why it is slow today (measured on this PC)

| Cause | Evidence | Fix |
|---|---|---|
| `qwen3:4b` is the *thinking* build | Form-fill: 3 min, ~5,500 chars of reasoning before a 4-field answer | Use `qwen3:4b-instruct-2507` (no thinking, same skills, has tool calling) |
| CPU only | `ollama ps` → `100% CPU`; Radeon 740M not used | Try Ollama's Vulkan backend (`OLLAMA_VULKAN=1`), small gain at best because the iGPU shares system RAM |
| ~7 GB RAM | 7B models ran at 0.5 tok/s (swapping); switching text ↔ vision unloads one to load the other (~10–20 s) | Smaller models, keep 2 small models loaded together, **RAM upgrade is the biggest win** (16–32 GB DDR5, dual channel) |
| Big prompts | Images and long history are re-sent every turn | Already resizing images to 1280 px and capping history at 20 messages |

---

## 2. Multi-model setup (the "Perplexity" idea)

Perplexity sends each question to the model that suits it best, adds web search, and runs things in parallel on big servers. On this PC, running models *at the same time* makes each one slower because they share the CPU and RAM. So Avobl will **route** each request to one well-chosen model, and keep the two most-used small models loaded so there are no reload pauses.

| Role | Model (free, local) | Size | Used for |
|---|---|---|---|
| Fast | `qwen3:1.7b` | ~1.4 GB | quick chat, choosing which model to use |
| Main | `qwen3:4b-instruct-2507-q4_K_M` | ~2.5 GB | chat, tool calls, form-fill, page Q&A |
| Vision | `qwen2.5vl:3b` | 3.2 GB | image insights, reading text in images |
| Vision pre-check | `moondream` | ~1.7 GB | cheap "is anything happening?" check for surveillance frames |
| Optional cloud (free tiers) | Groq / Google Gemini / OpenRouter free models | — | fast answers to ordinary questions **only when allowed**. Camera images never leave the machine |

Router logic (server side):
```
has image?                    → vision
needs tools (form / page)?    → main
short, simple question?       → fast
user picks "Best"?            → main (or cloud, if enabled)
```
Ollama settings on 8 GB RAM: `OLLAMA_MAX_LOADED_MODELS=1`, `keep_alive: "30m"` (one model at a time; raise to 2 after a 16 GB upgrade).

Remove the 7B models (`ollama rm qwen2.5:7b qwen2.5vl:7b`) until RAM is upgraded.

---

## 3. Architecture

```
                 ┌─────────────────────────── Avobl Core (Node server) ───────────────────────────┐
                 │  /api/chat  /api/vision  /api/watch/*   model router   providers: Ollama | cloud │
                 │  auth (API key per site)   CORS for VigilX   SQLite (insights, chats, rules)     │
                 └───────────────▲───────────────────────▲──────────────────────────▲─────────────┘
                                 │                       │                          │
          ┌──────────────────────┴───┐   ┌───────────────┴─────────────┐   ┌────────┴───────────────┐
          │ Avobl App (today's UI)   │   │ Avobl Widget (one <script>) │   │ Avobl Watch (worker)   │
          │ full-page chat, PWA      │   │ pill → side panel           │   │ new snapshot every     │
          └──────────────────────────┘   │ reads page, fills forms     │   │ 10 min → check →       │
                                         │ used in VigilX + extension  │   │ analyse → save → alert │
                                         └─────────────────────────────┘   └────────────────────────┘
```

**Same widget everywhere.** The widget is one JS bundle with its UI inside a Shadow DOM, so VigilX's CSS can't break it and it can't break VigilX:
- **In VigilX:** `<script src="https://<avobl-host>/widget.js" data-key="..."></script>`. It runs on the page, so it can read the page and fill inputs directly.
- **As an extension:** a Chrome (Manifest V3) extension injects the same bundle via a content script, or opens it in Chrome's **side panel** (fixed width, next to the page).

**Page access (read):** visible text, headings, tables, and a "form map" (label, name, type, required, options for each input), sent as context with the question.
**Page access (fill):** the model returns `{field: value}`, the widget shows a preview, and you click **Apply**. Values are set with real input/change events so React or Vue forms notice them. Avobl never submits a form by itself.

---

## 4. Surveillance: "Avobl Watch"

```
camera snapshot (every 10 min)
   → 1. change check (pixel diff vs last frame; skip if nothing changed)    ~ms
   → 2. quick look  (moondream: "people/vehicles/anything unusual?")         ~10–20 s
   → 3. full analysis only if needed (qwen2.5vl + your rules → JSON)         ~60–90 s
   → 4. save insight (SQLite: time, camera, findings, severity, image path)
   → 5. alert if a rule matches (shown in widget / VigilX; email/Telegram later)
```
**Capacity on this PC:** about 60–90 s per full analysis, so roughly 6–10 cameras at one frame per 10 minutes. The change check and quick look let it handle more.

**Insight format (example):**
```json
{ "camera": "gate-1", "time": "2026-10-28T14:20:00",
  "people": 2, "vehicles": 1, "events": ["person at gate after hours"],
  "severity": "medium", "confidence": "high", "summary": "..." }
```

**"Training", realistic steps:**
1. **Rules and instructions** (no training): "Flag anyone at the gate after 10 pm", "count vehicles in the parking area".
2. **Reference examples:** a few labelled images per rule, shown to the model as examples ("this is normal", "this is an intrusion").
3. **Evaluation set:** about 100 labelled snapshots, used to measure accuracy whenever we change a prompt or model.
4. **Real training, only if needed:** fine-tune a small detector (YOLO) on your camera images using free Colab GPUs. It runs on CPU in milliseconds and can replace step 2 of the pipeline.

Then you can ask Avobl about the history: "What happened at gate-1 between 2 and 4 pm?" It searches saved insights, not raw images.

---

## 5. Phases

| # | Phase | Done when |
|---|---|---|
| 0 | **Foundations:** git, faster models, router, `imageInstructions` TODO | Form-fill answers in < 15 s |
| 1 | **Core API:** split server into router/providers, settings file, API keys, CORS | Widget and app both use the same API |
| 2 | **Widget:** pill + side panel, page reader, form filler with Apply preview | Works on a demo page that looks like VigilX |
| 3 | **VigilX integration:** script tag, auth, styling | Pill live inside VigilX |
| 4 | **Extension:** MV3 + side panel reusing the widget | Same panel on any site |
| 5 | **Watch:** folder/API watcher, pipeline, SQLite, alerts, timeline | Insights saved automatically every 10 min |
| 6 | **Accuracy:** rules UI, examples, eval set, optional YOLO | Measured accuracy on your own footage |

---

## 6. Open questions (needed before phases 3 and 5)

1. **VigilX stack:** what is the frontend (React, Next, plain HTML…) and backend? Is it hosted online or on a local network?
2. **Where Avobl runs:** if VigilX is online, visitors' browsers can't reach Ollama on *this* laptop. Avobl Core then needs to run on a machine they can reach (your server or a PC on the same network).
3. **Snapshots:** where are they saved (a folder, VigilX's backend, cloud storage)? File naming? How many cameras?
4. **Rules:** the first 3–5 things the AI should detect or report.
5. **Cloud:** may ordinary (non-camera) chats use free cloud models for speed, or must everything stay local?
