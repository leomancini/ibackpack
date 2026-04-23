import dotenv from "dotenv";
dotenv.config({ override: true });
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

const controlClients = new Set();
let controlState = { paused: false, brightness: 100 };
let homeLastSeen = 0;

const BRIGHTNESS_LEVELS = [0, 50, 100];

function isHomeConnected() {
  return Date.now() - homeLastSeen < 3000;
}

function currentControlState() {
  return {
    paused: controlState.paused,
    brightness: controlState.brightness,
    homeConnected: isHomeConnected(),
  };
}

function broadcastControl(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of controlClients) {
    try { client.write(payload); } catch {}
  }
}

let lastBroadcastHomeConnected = false;
setInterval(() => {
  const connected = isHomeConnected();
  if (connected !== lastBroadcastHomeConnected) {
    lastBroadcastHomeConnected = connected;
    broadcastControl("state", currentControlState());
  }
}, 1000);

app.get("/api/control/events", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  res.write(`event: state\ndata: ${JSON.stringify(currentControlState())}\n\n`);
  controlClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    controlClients.delete(res);
  });
});

app.get("/api/control/state", (req, res) => {
  res.json(currentControlState());
});

let latestLocation = null;

app.post("/api/location", (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng required as numbers" });
  }
  latestLocation = { lat, lng, t: Date.now() };
  res.json({ ok: true });
});

app.post("/api/home/heartbeat", (req, res) => {
  const wasConnected = isHomeConnected();
  homeLastSeen = Date.now();
  if (!wasConnected) {
    lastBroadcastHomeConnected = true;
    broadcastControl("state", currentControlState());
  }
  res.json({ ok: true });
});

const mjpegClients = new Set();
let latestFrameBuffer = null;
const MJPEG_BOUNDARY = "ibackpackframe";

function writeMjpegFrame(client, buffer) {
  const head = Buffer.from(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`
  );
  try {
    client.write(head);
    client.write(buffer);
    client.write("\r\n");
  } catch {}
}

app.get("/api/stream.mjpeg", (req, res) => {
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    "Cache-Control": "no-cache, no-transform, no-store",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  mjpegClients.add(res);
  if (latestFrameBuffer) writeMjpegFrame(res, latestFrameBuffer);

  req.on("close", () => {
    mjpegClients.delete(res);
  });
});

app.get("/api/stream/viewers", (req, res) => {
  res.json({ viewers: mjpegClients.size });
});

app.post(
  "/api/stream/frame",
  express.raw({ type: "image/jpeg", limit: "5mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "missing image" });
    }
    latestFrameBuffer = req.body;
    for (const client of mjpegClients) writeMjpegFrame(client, req.body);
    res.json({ ok: true, viewers: mjpegClients.size });
  }
);

app.post("/api/control/brightness", (req, res) => {
  const { value } = req.body || {};
  if (!BRIGHTNESS_LEVELS.includes(value)) {
    return res.status(400).json({ error: "invalid brightness value" });
  }
  controlState = { ...controlState, brightness: value };
  broadcastControl("state", currentControlState());
  res.json({ ok: true, state: currentControlState(), receivers: controlClients.size });
});

app.post("/api/control/command", (req, res) => {
  const { action } = req.body || {};
  if (action === "play") controlState = { ...controlState, paused: false };
  else if (action === "pause") controlState = { ...controlState, paused: true };
  else if (action === "toggle") controlState = { ...controlState, paused: !controlState.paused };
  else return res.status(400).json({ error: "invalid action" });

  broadcastControl("state", currentControlState());
  res.json({ ok: true, state: currentControlState(), receivers: controlClients.size });
});

const describeClients = new Set();
let latestDescribe = null;

function broadcastDescribe(entry) {
  const payload = `event: describe\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const client of describeClients) {
    try { client.write(payload); } catch {}
  }
}

app.get("/api/describe/events", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  if (latestDescribe) {
    res.write(`event: describe\ndata: ${JSON.stringify(latestDescribe)}\n\n`);
  } else {
    res.write(`event: ping\ndata: {}\n\n`);
  }
  describeClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    describeClients.delete(res);
  });
});

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

    const loc = latestLocation;
    storage
      .saveEntry({
        imageBuffer: Buffer.from(data, "base64"),
        response: text,
        prompt,
        model,
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null
      })
      .catch((e) => console.error("[storage] saveEntry failed:", e));

    latestDescribe = {
      image,
      description: text,
      model,
      t: Date.now(),
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null
    };
    broadcastDescribe(latestDescribe);

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
