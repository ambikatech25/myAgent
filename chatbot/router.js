// Picks the right model for each message automatically.
// Rules, not AI: on 8 GB RAM, loading an extra model just to choose a model would cost more than it saves.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// For each role, the first model in the list that is installed wins.
// That way the app keeps working before you pull the newer models.
const PREFERRED = {
  fast: [process.env.FAST_MODEL, "qwen3:1.7b"],
  main: [process.env.MAIN_MODEL, "qwen3:4b-instruct-2507-q4_K_M", "qwen3:4b"],
  vision: [process.env.VISION_MODEL, "qwen2.5vl:3b", "gemma3:4b"],
};

// Qwen3 "hybrid" builds can skip their reasoning step. (The 2507 thinking build can't.)
export const THINK_OFF = new Set(["qwen3:1.7b"]);

// Words and patterns that suggest the user is sharing details to put in a form.
const FORM_HINTS = /\b(fill|form|my name|i am|i'm|address|email|phone|mobile|dob|date of birth|born)\b|@|\d{5,}/i;
const IMAGE_MEMORY = 4;   // a text question within 4 messages of an image is probably about that image
const LONG_MESSAGE = 280; // characters

async function ollama(path) {
  const res = await fetch(`${OLLAMA_URL}${path}`);
  if (!res.ok) throw new Error(`Ollama ${path} failed: ${res.status}`);
  return res.json();
}

let installedCache = { at: 0, names: new Set() };
async function installedModels() {
  if (Date.now() - installedCache.at < 30_000) return installedCache.names;
  const { models = [] } = await ollama("/api/tags");
  installedCache = { at: Date.now(), names: new Set(models.map((m) => m.name)) };
  return installedCache.names;
}

export async function loadedModels() {
  try {
    const { models = [] } = await ollama("/api/ps");
    return new Set(models.map((m) => m.name));
  } catch {
    return new Set();
  }
}

// Which installed model plays each role right now.
export async function resolveModels() {
  const installed = await installedModels();
  const pick = (list) => list.find((name) => name && installed.has(name)) ?? null;
  const main = pick(PREFERRED.main);
  return { main, fast: pick(PREFERRED.fast) ?? main, vision: pick(PREFERRED.vision) };
}

// Step 1: what kind of request is this?
export function chooseRole(messages, fields) {
  const last = messages.at(-1) ?? { content: "" };
  const text = last.content ?? "";
  const recentImage = messages.slice(-IMAGE_MEMORY).some((m) => m.images?.length);

  if (last.images?.length) return { role: "vision", reason: "image attached" };
  if (recentImage && !FORM_HINTS.test(text)) return { role: "vision", reason: "follow-up on an image" };
  if (fields.length && FORM_HINTS.test(text)) return { role: "main", reason: "details to fill" };
  if (text.length > LONG_MESSAGE || text.includes("```") || messages.length > 8) return { role: "main", reason: "bigger task" };
  return { role: "fast", reason: "quick question" };
}

// Step 2: turn the role into a model, avoiding a reload when a capable model is already in RAM.
export async function route(messages, fields) {
  const { role, reason } = chooseRole(messages, fields);
  const [models, loaded] = await Promise.all([resolveModels(), loadedModels()]);
  let model = models[role];

  // The main model can do anything the fast one can. If it's already loaded, use it instead of swapping.
  if (role === "fast" && models.main && loaded.has(models.main) && !loaded.has(models.fast)) model = models.main;

  return { role, reason, model, needsLoad: !!model && !loaded.has(model), models };
}
