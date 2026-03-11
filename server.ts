import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("lifeaidx.db");

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symptoms TEXT,
    severity TEXT,
    steps TEXT,
    specialist TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_fall_event INTEGER DEFAULT 0,
    lat REAL,
    lng REAL,
    hospital TEXT
  )
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/incidents", (req, res) => {
    try {
      const incidents = db.prepare("SELECT * FROM incidents ORDER BY timestamp DESC LIMIT 50").all();
      res.json(incidents.map(inc => ({
        ...inc,
        steps: JSON.parse(inc.steps as string),
        isFallEvent: !!inc.is_fall_event
      })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch incidents" });
    }
  });

  app.post("/api/incidents", (req, res) => {
    const { symptoms, severity, steps, specialist, isFallEvent, lat, lng, hospital } = req.body;
    try {
      const stmt = db.prepare(`
        INSERT INTO incidents (symptoms, severity, steps, specialist, is_fall_event, lat, lng, hospital)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        symptoms,
        severity,
        JSON.stringify(steps),
        specialist,
        isFallEvent ? 1 : 0,
        lat || null,
        lng || null,
        hospital || null
      );
      res.json({ id: result.lastInsertRowid });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to save incident" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
