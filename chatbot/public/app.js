// ---------- Small helpers ----------
const $ = (sel) => document.querySelector(sel);
const h = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};
const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  spark: svg('<path d="M12 3c.4 4.6 2.4 6.6 7 7-4.6.4-6.6 2.4-7 7-.4-4.6-2.4-6.6-7-7 4.6-.4 6.6-2.4 7-7z" fill="currentColor" stroke="none"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  form: svg('<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-4.5-4.5L6 21"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  clip: svg('<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>'),
  arrowUp: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  retry: svg('<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"/>'),
  trash: svg('<path d="M4 7h16M9 7V4.5h6V7M18 7l-.8 12.2a2 2 0 0 1-2 1.8H8.8a2 2 0 0 1-2-1.8L6 7"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};
document.querySelectorAll("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon]));

// localStorage can be full, blocked, or cleared: never let that break the app.
const storage = {
  load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

// ---------- State ----------
const DEFAULT_SETTINGS = {
  fields: ["full name", "email", "phone", "city", "date of birth"],
  parameters: ["main subject", "visible text", "image quality", "anything unusual"],
  theme: "auto",
};
let settings = { ...DEFAULT_SETTINGS, ...storage.load("settings", {}) };
let chats = storage.load("chats", []);
let activeId = null;
let pending = [];        // images attached but not sent yet (base64 JPEG)
let controller = null;   // AbortController of the reply being generated

const activeChat = () => chats.find((c) => c.id === activeId);
const toDataUrl = (b64) => `data:image/jpeg;base64,${b64}`;

function saveChats() {
  if (storage.save("chats", chats)) return;
  // Images fill storage fast: keep them only in the open chat and try again.
  for (const chat of chats) if (chat.id !== activeId) chat.messages.forEach((m) => delete m.images);
  if (!storage.save("chats", chats)) console.warn("Chat history could not be saved (storage full).");
}

// ---------- Theme & greeting ----------
function applyTheme() {
  if (settings.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}
function greet() {
  const hour = new Date().getHours();
  $("#greeting").textContent = hour < 5 ? "Up late?" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

// ---------- Sidebar ----------
const isMobile = () => matchMedia("(max-width: 860px)").matches;
function openSidebar() { $("#app").classList.remove("sidebar-collapsed"); $("#app").classList.add("sidebar-open"); }
function closeSidebar() { isMobile() ? $("#app").classList.remove("sidebar-open") : $("#app").classList.add("sidebar-collapsed"); }
$("#openSidebar").addEventListener("click", openSidebar);
$("#collapseSidebar").addEventListener("click", closeSidebar);
$("#scrim").addEventListener("click", closeSidebar);

function groupLabel(time) {
  const days = Math.floor((new Date().setHours(24, 0, 0, 0) - time) / 864e5);
  return days < 1 ? "Today" : days < 2 ? "Yesterday" : days < 7 ? "Previous 7 days" : "Older";
}

function renderChatList() {
  const list = $("#chatList");
  list.innerHTML = "";
  let lastGroup = null;
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const group = groupLabel(chat.updatedAt);
    if (group !== lastGroup) list.append(h("div", "chat-group", (lastGroup = group)));
    const item = h("div", `chat-item${chat.id === activeId ? " active" : ""}`);
    const title = h("button", "chat-item-title", chat.title);
    title.addEventListener("click", () => openChat(chat.id));
    const del = h("button", "chat-item-delete");
    del.title = "Delete chat";
    del.innerHTML = ICONS.trash;
    del.addEventListener("click", () => deleteChat(chat.id));
    item.append(title, del);
    list.append(item);
  }
}

function openChat(id) {
  if (controller) controller.abort();
  activeId = id;
  renderThread();
  renderChatList();
  if (isMobile()) closeSidebar();
}
function newChat() {
  openChat(null);
  $("#input").focus();
}
function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  saveChats();
  if (id === activeId) newChat();
  else renderChatList();
}
$("#newChat").addEventListener("click", newChat);

// ---------- Rendering the conversation ----------
function renderThread() {
  const chat = activeChat();
  $("#messages").innerHTML = "";
  $("#empty").hidden = !!chat;
  $("#chatTitle").textContent = chat?.title ?? "New chat";
  document.title = chat ? `${chat.title} · Avobl` : "Avobl";
  for (const msg of chat?.messages ?? []) {
    if (msg.role === "user") renderUser(msg);
    else paintAssistant(createAssistantView(), msg, false);
  }
  scrollToBottom(false);
}

function renderUser(msg) {
  const row = h("div", "msg user");
  const bubble = h("div", "bubble");
  if (msg.images?.length) {
    const grid = h("div", "bubble-images");
    for (const b64 of msg.images) {
      const img = new Image();
      img.src = toDataUrl(b64);
      img.alt = "Attached image";
      img.addEventListener("click", () => openLightbox(img.src));
      grid.append(img);
    }
    bubble.append(grid);
  }
  if (msg.content) bubble.append(h("div", "bubble-text", msg.content));
  row.append(bubble);
  $("#messages").append(row);
}

function createAssistantView() {
  const el = h("div", "msg assistant");
  const avatar = h("div", "avatar");
  avatar.innerHTML = ICONS.spark;
  const body = h("div", "msg-body");
  const thinking = h("details", "thinking");
  thinking.hidden = true;
  const summary = h("summary");
  summary.innerHTML = `<span class="thinking-label"></span>${ICONS.chevron}`;
  const thinkingText = h("div", "thinking-text");
  thinking.append(summary, thinkingText);
  const content = h("div", "markdown");
  const extras = h("div");
  const actions = h("div", "msg-actions");
  body.append(thinking, content, extras, actions);
  el.append(avatar, body);
  $("#messages").append(el);
  return { el, thinking, summary, thinkingText, content, extras, actions };
}

const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text, { breaks: true }));
const formatSecs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)}m`);

// Draws an assistant message from its current state; called repeatedly while streaming.
function paintAssistant(view, msg, streaming) {
  view.el.classList.toggle("streaming", streaming);

  if (msg.thinking) {
    const thinkingNow = streaming && !msg.content && !msg.form;
    view.thinking.hidden = false;
    view.thinking.classList.toggle("active", thinkingNow);
    view.summary.querySelector(".thinking-label").textContent =
      thinkingNow ? "Thinking…" : `Thought for ${formatSecs(msg.thinkingMs ?? 0)}`;
    view.thinkingText.textContent = msg.thinking;
    if (thinkingNow) view.thinkingText.scrollTop = view.thinkingText.scrollHeight;
  }

  if (msg.content) view.content.innerHTML = renderMarkdown(msg.content);
  else if (streaming && !msg.thinking && !msg.form) view.content.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  else view.content.innerHTML = "";

  view.extras.innerHTML = "";
  if (msg.form) view.extras.append(formCard(msg.form));
  if (msg.error) view.extras.append(h("div", "error-card", msg.error));
  if (msg.stopped) view.extras.append(h("div", "stopped-note", "Stopped"));

  view.actions.innerHTML = "";
  view.actions.hidden = streaming;
  if (!streaming) {
    addCodeCopyButtons(view.content);
    const text = msg.content || (msg.form ? JSON.stringify(msg.form, null, 2) : "");
    if (text) view.actions.append(iconButton("copy", "Copy", (btn) => copyText(text, btn)));
    view.actions.append(iconButton("retry", "Regenerate", () => regenerate(msg)));
    const meta = [msg.model, msg.stats?.tokensPerSec && `${msg.stats.tokensPerSec} tok/s`, msg.stats?.seconds && `${msg.stats.seconds}s`];
    view.actions.append(h("span", "msg-meta", meta.filter(Boolean).join(" · ")));
  }
}

function formCard(data) {
  const card = h("div", "form-card");
  const head = h("div", "form-card-head");
  head.innerHTML = `${ICONS.check}<span>Form filled</span>`;
  head.append(iconButton("copy", "Copy as JSON", (btn) => copyText(JSON.stringify(data, null, 2), btn)));
  const rows = h("dl", "form-rows");
  const keys = [...new Set([...settings.fields, ...Object.keys(data)])];
  for (const key of keys) {
    const value = data[key];
    rows.append(h("dt", null, key), h("dd", value ? null : "missing", value || "Not provided"));
  }
  card.append(head, rows);
  return card;
}

function addCodeCopyButtons(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    const btn = h("button", "code-copy", "Copy");
    btn.addEventListener("click", () => copyText(pre.querySelector("code")?.innerText ?? pre.innerText, btn, true));
    pre.append(btn);
  });
}

function iconButton(icon, title, onClick) {
  const btn = h("button", "icon-btn");
  btn.type = "button";
  btn.title = title;
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

async function copyText(text, btn, isTextButton = false) {
  await navigator.clipboard.writeText(text);
  const before = btn.innerHTML;
  btn.innerHTML = isTextButton ? "Copied" : ICONS.check;
  setTimeout(() => (btn.innerHTML = before), 1400);
}

// Only follow the stream if the user hasn't scrolled up to read something.
const nearBottom = () => { const t = $("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 140; };
function scrollToBottom(smooth = true) {
  const t = $("#thread");
  t.scrollTo({ top: t.scrollHeight, behavior: smooth ? "smooth" : "instant" });
}

// ---------- Talking to the server ----------
// What the model sees: plain role/content/images. UI-only fields (thinking, stats…) stay local.
function toApiMessages(messages) {
  return messages
    .filter((m) => !m.error)
    .map((m) => {
      if (m.role === "user") {
        const out = { role: "user", content: m.content || "Please analyse this image." };
        if (m.images?.length) out.images = m.images;
        return out;
      }
      const content = m.content || (m.form ? `I filled the form with: ${JSON.stringify(m.form)}` : "");
      return { role: "assistant", content };
    })
    .filter((m) => m.content);
}

// The server sends NDJSON: one JSON event per line.
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
}

function makeTitle(text, hasImages) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return hasImages ? "Image analysis" : "New chat";
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

async function send(text) {
  if (controller) return;
  text = text.trim();
  if (!text && !pending.length) return;

  let chat = activeChat();
  if (!chat) {
    chat = { id: crypto.randomUUID(), title: makeTitle(text, pending.length > 0), messages: [], updatedAt: Date.now() };
    chats.push(chat);
    activeId = chat.id;
    renderThread();
  }
  const userMsg = { role: "user", content: text };
  if (pending.length) userMsg.images = pending.map((p) => p.b64);
  chat.messages.push(userMsg);
  renderUser(userMsg);
  resetComposer();
  await respond(chat);
}

async function respond(chat) {
  const reply = { role: "assistant", content: "", thinking: "" };
  const history = toApiMessages(chat.messages);
  chat.messages.push(reply);
  chat.updatedAt = Date.now();
  renderChatList();

  const view = createAssistantView();
  paintAssistant(view, reply, true);
  scrollToBottom();
  controller = new AbortController();
  updateSendButton();

  let thinkStart = null;
  const endThinking = () => { if (thinkStart && reply.thinkingMs == null) reply.thinkingMs = performance.now() - thinkStart; };
  let queued = false;
  const repaint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!controller) return; // the final paint already happened
      const stick = nearBottom();
      paintAssistant(view, reply, true);
      if (stick) scrollToBottom(false);
    });
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, fields: settings.fields, parameters: settings.parameters }),
      signal: controller.signal,
    });
    for await (const event of readEvents(res)) {
      if (event.type === "meta") reply.model = event.model;
      else if (event.type === "thinking") { thinkStart ??= performance.now(); reply.thinking += event.text; }
      else if (event.type === "content") { endThinking(); reply.content += event.text; }
      else if (event.type === "form") { endThinking(); reply.form = { ...reply.form, ...event.data }; fillForm(reply.form); }
      else if (event.type === "stats") reply.stats = event;
      else if (event.type === "error") reply.error = event.message;
      repaint();
    }
  } catch (err) {
    if (err.name === "AbortError") reply.stopped = true;
    else reply.error = "Lost connection to the server. Is `npm start` still running?";
  }
  endThinking();
  if (!reply.content && !reply.form && !reply.error && !reply.stopped) reply.error = "The model returned an empty answer. Try again.";
  controller = null;
  paintAssistant(view, reply, false);
  updateSendButton();
  saveChats();
}

function regenerate(msg) {
  const chat = activeChat();
  if (!chat || controller) return;
  const index = chat.messages.indexOf(msg);
  chat.messages.splice(index); // drop this answer (and anything after it)
  renderThread();
  respond(chat);
}

// ---------- Composer ----------
const input = $("#input");
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}
function updateSendButton() {
  const btn = $("#sendBtn");
  const busy = !!controller;
  btn.classList.toggle("stop", busy);
  btn.innerHTML = busy ? ICONS.stop : ICONS.arrowUp;
  btn.title = busy ? "Stop" : "Send";
  btn.disabled = !busy && !input.value.trim() && !pending.length;
}
function resetComposer() {
  input.value = "";
  pending = [];
  renderAttachments();
  autosize();
  updateSendButton();
}

input.addEventListener("input", () => { autosize(); updateSendButton(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (controller) controller.abort();
  else send(input.value);
});

// ---------- Images: attach, paste, drop ----------
// Shrinking big photos before sending makes the vision model much faster on a CPU.
function resizeImage(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black as JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't read ${file.name}`)); };
    img.src = url;
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try { pending.push({ b64: await resizeImage(file) }); } catch (err) { console.warn(err.message); }
  }
  renderAttachments();
  updateSendButton();
  input.focus();
}

function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  box.hidden = pending.length === 0;
  pending.forEach((item, i) => {
    const wrap = h("div", "attachment");
    const img = new Image();
    img.src = toDataUrl(item.b64);
    const remove = h("button");
    remove.type = "button";
    remove.title = "Remove";
    remove.innerHTML = ICONS.x;
    remove.addEventListener("click", () => { pending.splice(i, 1); renderAttachments(); updateSendButton(); });
    wrap.append(img, remove);
    box.append(wrap);
  });
}

$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
input.addEventListener("paste", (e) => {
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer.types.includes("Files")) { dragDepth++; $("#dropOverlay").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#dropOverlay").hidden = true;
  addFiles(e.dataTransfer.files);
});

function openLightbox(src) {
  $("#lightbox img").src = src;
  $("#lightbox").showModal();
}
$("#lightbox").addEventListener("click", () => $("#lightbox").close());

// ---------- Empty-state suggestions ----------
document.querySelectorAll(".suggestion").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn.dataset.action === "attach") return $("#fileInput").click();
    send(btn.dataset.prompt);
  }));

// ---------- Form panel (stands in for a form on your website) ----------
function buildForm() {
  const form = $("#demoForm");
  form.innerHTML = "";
  for (const field of settings.fields) {
    const label = h("label", null, field);
    const inputEl = h("input");
    inputEl.name = field;
    inputEl.addEventListener("input", () => inputEl.classList.remove("filled"));
    label.append(inputEl);
    form.append(label);
  }
}
function fillForm(data) {
  $("#formPanel").hidden = false;
  for (const el of $("#demoForm").elements) {
    if (!(el.name in data)) continue;
    el.value = data[el.name] ?? "";
    el.classList.toggle("filled", !!data[el.name]);
  }
}
$("#toggleForm").addEventListener("click", () => ($("#formPanel").hidden = !$("#formPanel").hidden));
$("#closeForm").addEventListener("click", () => ($("#formPanel").hidden = true));
$("#clearForm").addEventListener("click", () => {
  for (const el of $("#demoForm").elements) { el.value = ""; el.classList.remove("filled"); }
});

// ---------- Settings ----------
const splitList = (text) => text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
$("#openSettings").addEventListener("click", () => {
  const form = $("#settingsForm");
  form.fields.value = settings.fields.join(", ");
  form.parameters.value = settings.parameters.join(", ");
  form.theme.value = settings.theme;
  $("#settings").showModal();
});
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  const form = $("#settingsForm");
  settings = {
    fields: splitList(form.fields.value),
    parameters: splitList(form.parameters.value),
    theme: form.theme.value,
  };
  storage.save("settings", settings);
  applyTheme();
  buildForm();
});

// ---------- Startup ----------
async function connect() {
  const status = $("#modelStatus");
  try {
    const { models } = await (await fetch("/api/config")).json();
    $("#modelStatusText").textContent = `${models.text} · ${models.vision}`;
    $("#textModel").textContent = models.text;
    $("#visionModel").textContent = models.vision;
    status.classList.add("online");
    fetch("/api/warmup", { method: "POST" }); // preload the model while you type
  } catch {
    $("#modelStatusText").textContent = "Server offline";
    status.classList.add("offline");
  }
}

applyTheme();
greet();
buildForm();
renderChatList();
renderThread();
updateSendButton();
connect();
input.focus();
