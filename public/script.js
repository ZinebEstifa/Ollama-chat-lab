const $ = (id) => document.getElementById(id);
const modelSel = $("model"), thinkBox = $("think"), thinkLabel = $("thinkLabel");
const jsonBox = $("json"), messagesEl = $("messages"), input = $("input");
const sendBtn = $("send"), stopBtn = $("stop"), statsEl = $("stats");
const imgInput = $("img"), imgLabel = $("imgLabel"), imgName = $("imgName");

// ---------- état ----------
let history = [];          // Ollama est stateless : on garde TOUT l'historique ici
let models = [];
let controller = null;
let busy = false;
let imageB64 = null;       // [E]

// [C2] token demandé une fois, gardé en mémoire uniquement
const token = prompt("Token d'accès :") || "";
const headers = () => ({ "Content-Type": "application/json", Authorization: "Bearer " + token });

// [D] schéma de la sortie structurée
const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "tags"],
};

// ---------- [B] rendu Markdown SÉCURISÉ ----------
function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));   // toujours sanitize avant innerHTML
}

// ---------- lecture NDJSON avec tampon ----------
async function* readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();                         // dernière ligne peut-être incomplète
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

// ---------- UI ----------
function addUser(text, withImage) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = (withImage ? "🖼️ " : "") + text;      // textContent : sûr
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addAssistant() {
  const d = document.createElement("div");
  d.className = "msg assistant";
  const details = document.createElement("details");
  details.className = "think";
  details.hidden = true;
  details.innerHTML = "<summary>Reasoning</summary>";
  const pre = document.createElement("pre");
  details.appendChild(pre);
  const answer = document.createElement("div");
  answer.className = "answer";
  d.append(details, answer);
  messagesEl.appendChild(d);
  return { root: d, details, pre, answer };
}

function addError(text) {
  const d = document.createElement("div");
  d.className = "msg error";
  d.textContent = "⚠️ " + text;
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setBusy(b) {
  busy = b;
  input.disabled = modelSel.disabled = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
}

const caps = () => models.find((m) => m.name === modelSel.value)?.capabilities || [];
function updateCaps() {
  thinkLabel.hidden = !caps().includes("thinking");
  imgLabel.hidden = !caps().includes("vision");           // [E]
  if (imgLabel.hidden) { imageB64 = null; imgName.textContent = ""; }
}

// ---------- chargement des modèles ----------
async function loadModels() {
  try {
    const r = await fetch("/api/models", { headers: headers() });
    if (!r.ok) throw new Error((await r.json()).error || "HTTP " + r.status);
    models = await r.json();
    modelSel.innerHTML = "";
    for (const m of models) modelSel.add(new Option(m.name, m.name));
    updateCaps();
  } catch (e) {
    addError("Impossible de charger les modèles : " + e.message);
  }
}
modelSel.addEventListener("change", updateCaps);

// [A] affichage du slider
$("temp").addEventListener("input", () => ($("tempVal").textContent = $("temp").value));

// [E] lecture de l'image en base64
imgInput.addEventListener("change", () => {
  const file = imgInput.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    imageB64 = fr.result.split(",")[1];           // on retire "data:image/png;base64,"
    imgName.textContent = file.name;
  };
  fr.readAsDataURL(file);
});

// ---------- envoi ----------
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;

  const userMsg = { role: "user", content: text };
  if (imageB64) userMsg.images = [imageB64];
  history.push(userMsg);
  addUser(text, !!imageB64);
  input.value = "";
  imageB64 = null; imgName.textContent = ""; imgInput.value = "";

  // [A] le system prompt n'est PAS dans history : ajouté à la volée
  const sys = $("system").value.trim();
  // les images ne sont gardées que sur le dernier message (allège les requêtes)
  const past = history.map((m, i) =>
    i === history.length - 1 ? m : { role: m.role, content: m.content });
  const messages = sys ? [{ role: "system", content: sys }, ...past] : past;

  const payload = {
    messages,
    model: modelSel.value,
    stream: true,
    options: { temperature: Number($("temp").value), num_ctx: Number($("ctx").value) },
  };
  if (caps().includes("thinking")) payload.think = thinkBox.checked;
  if (jsonBox.checked) {                                   // [D]
    payload.format = SCHEMA;
    payload.options.temperature = Math.min(payload.options.temperature, 0.3);
  }

  const ui = addAssistant();
  let answer = "", thinking = "", last = null;
  controller = new AbortController();
  setBusy(true);
  statsEl.textContent = "";

  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: headers(), body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || "HTTP " + r.status);
    }

    for await (const chunk of readNdjson(r)) {
      if (chunk.error) throw new Error(chunk.error);       // erreur au milieu du flux
      if (chunk.message?.thinking) {
        thinking += chunk.message.thinking;
        ui.details.hidden = false;
        ui.pre.textContent = thinking;                     // textContent
      }
      if (chunk.message?.content) {
        answer += chunk.message.content;
        if (jsonBox.checked) ui.answer.textContent = answer;   // JSON brut pendant le flux
        else renderMarkdown(ui.answer, answer);                // [B]
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (chunk.done) last = chunk;
    }

    history.push({ role: "assistant", content: answer });

    if (jsonBox.checked) {                                 // [D] affichage structuré
      try {
        const data = JSON.parse(answer);
        ui.answer.innerHTML = "";
        const h = document.createElement("strong");
        h.textContent = data.title;
        ui.answer.appendChild(h);
        ui.answer.appendChild(document.createElement("br"));
        for (const t of data.tags) {
          const s = document.createElement("span");
          s.className = "tag"; s.textContent = t;
          ui.answer.appendChild(s);
        }
      } catch { /* JSON invalide : on laisse le texte brut */ }
    }

    if (last?.eval_count && last?.eval_duration) {         // stats bonus
      const tps = last.eval_count / (last.eval_duration / 1e9);
      statsEl.textContent = `${last.eval_count} tokens · ${tps.toFixed(1)} tokens/s`;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // Stop : pas une erreur, on garde la réponse partielle
      if (answer) history.push({ role: "assistant", content: answer });
      else { history.pop(); ui.root.remove(); }
      statsEl.textContent = "⏹ Arrêté";
    } else {
      history.pop();                                       // retire le message sans réponse
      if (!answer) ui.root.remove();
      addError(err.message);
    }
  } finally {
    controller = null;
    setBusy(false);
    input.focus();
  }
}

// ---------- événements ----------
$("form").addEventListener("submit", (e) => { e.preventDefault(); send(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); }
});
stopBtn.addEventListener("click", () => controller?.abort());
$("newChat").addEventListener("click", () => {
  controller?.abort();
  history = [];
  messagesEl.innerHTML = "";
  statsEl.textContent = "";
});

loadModels();