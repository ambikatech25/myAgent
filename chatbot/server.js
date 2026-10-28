import express from "express";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const PORT = process.env.PORT || 3000;

// Swap models without touching code: set TEXT_MODEL / VISION_MODEL before `npm start`.
const MODELS = {
  text: process.env.TEXT_MODEL || "qwen3:4b",
  vision: process.env.VISION_MODEL || "qwen2.5vl:3b",
};
const MAX_HISTORY = 20; // older messages are dropped so prompts stay small and fast

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));
// Browser builds of the Markdown renderer and HTML sanitiser, served locally so it all works offline.
app.use("/vendor/marked", express.static("node_modules/marked/lib"));
app.use("/vendor/dompurify", express.static("node_modules/dompurify/dist"));

// No mode switch any more: if the conversation contains an image, the vision model answers.
function pickModel(messages) {
  return messages.some((m) => m.images?.length) ? MODELS.vision : MODELS.text;
}

// How the vision model should report on an image, given the parameters set in Settings.
function imageInstructions(parameters) {
  // TODO(human): turn `parameters` into instructions for how insights are presented.
  return parameters.length ? `When analysing an image, cover: ${parameters.join(", ")}.` : "";
}

function systemPrompt({ vision, fields, parameters }) {
  const lines = [
    "You are Avobl, a warm, capable personal assistant running locally on the user's computer.",
    "Use Markdown (short headings, lists, tables, code blocks) when it makes answers easier to read. Keep answers focused.",
  ];
  if (vision) lines.push(imageInstructions(parameters));
  else if (fields.length) {
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

app.get("/api/config", (req, res) => res.json({ models: MODELS }));

// Load the text model into RAM as soon as the page opens, so the first reply skips the ~10s load.
app.post("/api/warmup", async (req, res) => {
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: MODELS.text, keep_alive: "30m" }),
  }).catch(() => { });
  res.sendStatus(204);
});

app.post("/api/chat", async (req, res) => {
  const { messages = [], fields = [], parameters = [] } = req.body;
  const history = messages.slice(-MAX_HISTORY).map(({ role, content, images }) =>
    images?.length ? { role, content, images } : { role, content });
  const model = pickModel(history);
  const vision = model === MODELS.vision;

  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt({ vision, fields, parameters }) }, ...history],
    stream: true,
    keep_alive: "30m",
  };
  if (!vision && fields.length) body.tools = [fillFormTool(fields)];

  const abort = new AbortController();
  res.on("close", () => abort.abort()); // Stop button or closed tab: stop generating

  // We stream our own NDJSON events to the browser: one {type, ...} object per line.
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  const emit = (event) => res.write(JSON.stringify(event) + "\n");

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

  emit({ type: "meta", model });
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
