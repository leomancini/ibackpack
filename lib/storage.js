import sharp from "sharp";
import fs from "fs";
import fsp from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";

const MAX_BYTES = 1024 * 1024 * 1024;
const EVICT_START = 900 * 1024 * 1024;
const EVICT_TARGET = 800 * 1024 * 1024;

export function createStorage({ db, dir }) {
  fs.mkdirSync(dir, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_entries (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      image_filename TEXT NOT NULL,
      image_size INTEGER NOT NULL,
      response_text TEXT NOT NULL,
      response_size INTEGER NOT NULL,
      prompt TEXT,
      model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claude_entries_created
      ON claude_entries(created_at DESC);
  `);

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const totalStmt = db.prepare(
    "SELECT COALESCE(SUM(image_size + response_size), 0) AS total FROM claude_entries"
  );
  const oldestStmt = db.prepare(
    "SELECT id, image_filename, image_size, response_size FROM claude_entries ORDER BY created_at ASC LIMIT 1"
  );
  const deleteStmt = db.prepare("DELETE FROM claude_entries WHERE id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO claude_entries
      (id, created_at, image_filename, image_size, response_text, response_size, prompt, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT id, created_at, image_filename, image_size, response_text, response_size, prompt, model
    FROM claude_entries
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  const getStmt = db.prepare("SELECT * FROM claude_entries WHERE id = ?");

  function getTotalBytes() {
    return totalStmt.get().total || 0;
  }

  async function evictIfNeeded() {
    let total = getTotalBytes();
    if (total < EVICT_START) return;

    while (total > EVICT_TARGET) {
      const oldest = oldestStmt.get();
      if (!oldest) break;
      try {
        await fsp.unlink(join(dir, oldest.image_filename));
      } catch (e) {
        if (e.code !== "ENOENT") console.warn("[storage] unlink failed:", e.message);
      }
      deleteStmt.run(oldest.id);
      total -= oldest.image_size + oldest.response_size;
      emitter.emit("evict", { id: oldest.id });
    }
  }

  async function saveEntry({ imageBuffer, response, prompt = null, model = null }) {
    const id = randomUUID();
    const createdAt = Date.now();

    const resized = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1080, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const imageFilename = `${id}.jpg`;
    await fsp.writeFile(join(dir, imageFilename), resized);

    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const responseSize = Buffer.byteLength(responseText, "utf8");

    insertStmt.run(
      id,
      createdAt,
      imageFilename,
      resized.length,
      responseText,
      responseSize,
      prompt,
      model
    );

    const entry = {
      id,
      created_at: createdAt,
      image_filename: imageFilename,
      image_size: resized.length,
      response_text: responseText,
      response_size: responseSize,
      prompt,
      model
    };
    emitter.emit("add", entry);

    evictIfNeeded().catch((e) => console.error("[storage] eviction failed:", e));

    return entry;
  }

  function listEntries({ limit = 200, offset = 0 } = {}) {
    return listStmt.all(limit, offset);
  }

  function getEntry(id) {
    return getStmt.get(id);
  }

  function getImagePath(filename) {
    if (!/^[a-f0-9-]+\.jpg$/i.test(filename)) return null;
    return join(dir, filename);
  }

  return {
    saveEntry,
    listEntries,
    getEntry,
    getImagePath,
    getTotalBytes,
    maxBytes: MAX_BYTES,
    on: (event, cb) => emitter.on(event, cb),
    off: (event, cb) => emitter.off(event, cb)
  };
}
