import 'dotenv/config';
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import Database from "better-sqlite3";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createStorage } from "./lib/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3132;
const anthropic = new Anthropic();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// SQLite setup
const db = new Database(join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");

// Persistent store for Claude image calls + responses
const storage = createStorage({
  db,
  dir: join(__dirname, "storage", "images")
});

const galleryHtml = fs.readFileSync(
  join(__dirname, "lib", "admin-gallery.html"),
  "utf8"
);

app.use(express.json({ limit: "25mb" }));

// Serve static files from dist
app.use(express.static(join(__dirname, "dist")));

app.post("/api/describe", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: "missing image" });

    const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "invalid image data" });
    const [, mediaType, data] = match;

    const model = "claude-haiku-4-5";
    const prompt =
      "You are a camera mounted on a backpack, looking out at the world. Describe what you see around you in one short sentence. Respond with plain prose only — no markdown, no headings, no hashtags, no bullet points, no leading punctuation.";

    const message = await anthropic.messages.create({
      model,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: prompt }
          ]
        }
      ]
    });

    const raw = message.content.find((b) => b.type === "text")?.text ?? "";
    const text = raw.replace(/^[#\s*>`-]+/, "").trim();

    storage
      .saveEntry({
        imageBuffer: Buffer.from(data, "base64"),
        response: text,
        prompt,
        model
      })
      .catch((e) => console.error("[storage] saveEntry failed:", e));

    res.json({ description: text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint for SQLite queries
app.post("/api/query", (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all(...params);
      res.json({ rows });
    } else {
      const result = stmt.run(...params);
      res.json({ result });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).type("text/plain").send("ADMIN_KEY not configured");
  }
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).type("text/plain").send("Unauthorized");
  }
  next();
}

app.get("/admin/gallery", requireAdminKey, (req, res) => {
  res.type("html").send(galleryHtml);
});

app.get("/admin/gallery/api/entries", requireAdminKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json({
    entries: storage.listEntries({ limit, offset }),
    total_bytes: storage.getTotalBytes(),
    max_bytes: storage.maxBytes
  });
});

app.get("/admin/gallery/image/:filename", requireAdminKey, (req, res) => {
  const path = storage.getImagePath(req.params.filename);
  if (!path || !fs.existsSync(path)) {
    return res.status(404).type("text/plain").send("Not found");
  }
  res.type("image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(path).pipe(res);
});

app.get("/admin/gallery/events", requireAdminKey, (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  send("ping", { ok: true });

  const onAdd = (entry) =>
    send("add", { entry, total_bytes: storage.getTotalBytes(), max_bytes: storage.maxBytes });
  const onEvict = ({ id }) =>
    send("evict", { id, total_bytes: storage.getTotalBytes(), max_bytes: storage.maxBytes });

  storage.on("add", onAdd);
  storage.on("evict", onEvict);

  const heartbeat = setInterval(() => {
    try { send("ping", { t: Date.now() }); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    storage.off("add", onAdd);
    storage.off("evict", onEvict);
  });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
