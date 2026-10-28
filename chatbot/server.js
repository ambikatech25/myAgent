import express from "express";
import { route, resolveModels, THINK_OFF } from "./router.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 20; // older messages are dropped so prompts stay small and fast

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));
// Browser builds of the Markdown renderer and HTML sanitiser, served locally so it all works offline.
app.use("/vendor/marked", express.static("node_modules/marked/lib"));
app.use("/vendor/dompurify", express.static("node_modules/dompurify/dist"));

// How the vision model should report on an image, given the parameters set in Settings.
function imageInstructions(parameters) {
  // TODO(human): turn `parameters` into instructions for how insights are presented.
  return parameters.length ? `When analysing an image, cover: ${parameters.join(", ")}.` : "";
}

function systemPrompt({ role, fields, parameters }) {
  const lines = [
    "You are Avobl, a warm, capable personal assistant running locally on the user's computer.",
    "Use Markdown (short headings, lists, tables, code blocks) when it makes answers easier to read. Keep answers focused.",
  ];
  if (role === "vision") lines.push(imageInstructions(parameters));
  if (role === "main" && fields.length) {
    lines.push(
      "When the user shares personal or contact details, or asks you to fill a form, call the fill_form tool.",
      "Only pass values that are clearly in the conversation. Never invent values.",
    );
  }
  return lines.filter(Boolean).join("\n");
}

// The model sees this tool and decides by itself when to call it.
function fillFormTool(fields) {
  return {
    type: "function",
    function: {
      name: "fill_form",
      description: "Fill the user's form with details found in the conversation.",
      parameters: {
        type: "object",
        properties: Object.fromEntries(fields.map((f) => [f, { type: "string", description: f }])),
      },
    },
  };
}

app.get("/api/config", async (req, res) => {
  try {
    res.json({ models: await resolveModels() });
  } catch {
    res.status(503).json({ error: "Can't reach Ollama." });
  }
});

// Load the main model into RAM as soon as the page opens, so the first reply skips the load time.
app.post("/api/warmup", async (req, res) => {
  res.sendStatus(204);
  const { main } = await resolveModels().catch(() => ({}));
  if (main) fetch(`${OLLAMA_URL}/api/generate`, { method: "POST", body: JSON.stringify({ model: main, keep_alive: "30m" }) }).catch(() => {});
});

app.post("/api/chat", async (req, res) => {
  const { messages = [], fields = [], parameters = [] } = req.body;
  const history = messages.slice(-MAX_HISTORY);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  const emit = (event) => res.write(JSON.stringify(event) + "\n");

  let decision;
  try {
    decision = await route(history, fields);
  } catch {
    emit({ type: "error", message: "Can't reach Ollama. Make sure it's running." });
    return res.end();
  }
  const { role, reason, model, needsLoad } = decision;
  if (!model) {
    emit({ type: "error", message: `No ${role} model is installed. Pull one with \`ollama pull\` (see PLAN.md).` });
    return res.end();
  }

  // Text-only models reject images, so earlier images are swapped for a short note.
  const cleaned = history.map(({ role: r, content, images }) => {
    if (!images?.length) return { role: r, content };
    return role === "vision" ? { role: r, content, images } : { role: r, content: `${content}\n[an image was attached here]` };
  });

  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt({ role, fields, parameters }) }, ...cleaned],
    stream: true,
    keep_alive: "30m",
  };
  if (role === "main" && fields.length) body.tools = [fillFormTool(fields)];
  if (THINK_OFF.has(model)) body.think = false;

  const abort = new AbortController();
  res.on("close", () => abort.abort()); // Stop button or closed tab: stop generating

  emit({ type: "meta", model, role, reason });
  if (needsLoad) emit({ type: "status", text: `Loading ${model}…` });

  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch {
    emit({ type: "error", message: "Can't reach Ollama. Make sure it's running." });
    return res.end();
  }
  if (!upstream.ok) {
    emit({ type: "error", message: (await upstream.text()) || upstream.statusText });
    return res.end();
  }

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // the last line may be cut off; finish it with the next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line);
        if (data.error) emit({ type: "error", message: data.error });
        if (data.message?.thinking) emit({ type: "thinking", text: data.message.thinking });
        if (data.message?.content) emit({ type: "content", text: data.message.content });
        for (const call of data.message?.tool_calls ?? []) {
          if (call.function?.name === "fill_form") emit({ type: "form", data: call.function.arguments });
        }
        if (data.done) {
          emit({
            type: "stats",
            tokensPerSec: data.eval_duration ? +(data.eval_count / (data.eval_duration / 1e9)).toFixed(1) : null,
            seconds: +(data.total_duration / 1e9).toFixed(1),
          });
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") emit({ type: "error", message: err.message });
  }
  res.end();
});

app.listen(PORT, () => console.log(`Avobl running at http://localhost:${PORT}`));
