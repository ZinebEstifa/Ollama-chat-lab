import express from "express";
import rateLimit from "express-rate-limit";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma4:e4b";
const API_TOKEN = process.env.API_TOKEN;          // [C2]
const PORT = process.env.PORT || 3000;

// [C3] limites de taille
const MAX_MESSAGES = 50;
const MAX_CHARS = 8000;
const MAX_IMAGE_CHARS = 8_000_000;                // ~6 Mo d'image en base64
const ROLES = ["system", "user", "assistant"];
const ALLOWED_OPTIONS = ["temperature", "num_ctx", "top_p", "seed"];  // [A] liste blanche
const JSON_HEADERS = { "Content-Type": "application/json" };

const app = express();
if (!API_TOKEN) console.warn("⚠️  API_TOKEN non défini : l'authentification est DÉSACTIVÉE");

app.use(express.static("public"));                // la page reste publique

// [C1] limitation de débit : 20 requêtes / minute / IP
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
}));

// [C2] authentification par token (en-tête Authorization: Bearer ...)
app.use("/api", (req, res, next) => {
  if (!API_TOKEN) return next();
  const token = (req.get("Authorization") || "").replace("Bearer ", "");
  if (token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// [C3] limite globale du corps (10 Mo à cause des images de l'exercice E)
app.use(express.json({ limit: "10mb" }));

// ---------- POST /api/chat ----------
app.post("/api/chat", async (req, res) => {
  const { messages, model, stream = true, think, options, format } = req.body ?? {};

  // validation
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages must be a non-empty array" });

  const invalid = messages.some(
    (m) => !m || !ROLES.includes(m.role) || typeof m.content !== "string"
  );
  if (invalid) return res.status(400).json({ error: "Invalid message format" });

  // [C3] taille
  const tooBig =
    messages.length > MAX_MESSAGES ||
    messages.some(
      (m) =>
        m.content.length > MAX_CHARS ||
        (m.images &&
          (!Array.isArray(m.images) ||
            m.images.some((i) => typeof i !== "string" || i.length > MAX_IMAGE_CHARS)))
    );
  if (tooBig) return res.status(413).json({ error: "Payload too large" });

  // construction du corps envoyé à Ollama
  const body = { model: model || DEFAULT_MODEL, messages, stream: stream !== false };
  if (think !== undefined) body.think = think;                       // passé tel quel
  if (format !== undefined) body.format = format;                    // [D]

  if (options && typeof options === "object") {                      // [A] filtré
    const clean = {};
    for (const k of ALLOWED_OPTIONS)
      if (typeof options[k] === "number") clean[k] = options[k];
    if (clean.num_ctx) clean.num_ctx = Math.min(clean.num_ctx, 16384);
    body.options = clean;
  }

  // annulation : quand la connexion avec le navigateur se ferme
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) {   // ex : modèle introuvable, think non supporté
      const txt = await r.text();
      let msg = `Ollama error ${r.status}`;
      try { msg = JSON.parse(txt).error || msg; } catch {}
      return res.status(r.status).json({ error: msg });
    }

    if (!body.stream) return res.json(await r.json());

    res.setHeader("Content-Type", "application/x-ndjson");
    await pipeline(Readable.fromWeb(r.body), res);   // on transmet les octets tels quels
  } catch (err) {
    if (ac.signal.aborted) return;                   // le client est parti : ce n'est pas une erreur
    if (res.headersSent) return res.end();           // trop tard pour envoyer du JSON
    res.status(502).json({ error: "Cannot reach Ollama" });
  }
});

// ---------- GET /api/models ----------
app.get("/api/models", async (req, res) => {
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
    const models = await Promise.all(
      tags.models.map(async (m) => {
        const r = await fetch(`${OLLAMA}/api/show`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ model: m.name }),
        });
        const info = await r.json();
        return { name: m.name, capabilities: info.capabilities || [] };
      })
    );
    res.json(models);
  } catch {
    res.status(502).json({ error: "Cannot reach Ollama" });
  }
});

// erreurs JSON (corps trop gros, JSON invalide)
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));