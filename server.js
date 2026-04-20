const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000; // elke 2 minuten

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const FRUIT_PRICES = {
  "Spring": 60000, "Bomb": 80000, "Smoke": 100000,
  "Spike": 180000, "Flame": 250000, "Ice": 350000, "Sand": 420000, "Dark": 500000,
  "Ghost": 550000, "Diamond": 600000, "Light": 650000, "Rubber": 750000, "Magma": 850000,
  "Quake": 1000000, "Buddha": 1200000, "Love": 1300000, "Spider": 1500000, "Sound": 1700000,
  "Phoenix": 1800000, "Portal": 1900000, "Rumble": 2100000, "Blizzard": 2400000,
  "Gravity": 2500000, "Mammoth": 2700000, "T-Rex": 2700000, "Dough": 2800000,
  "Shadow": 2900000, "Venom": 3000000, "Control": 3200000, "Spirit": 3400000,
  "Kitsune": 8000000, "Dragon": 15000000,
  "Blade": 60000, "Eagle": 650000, "Creation": 1400000,
  "Lightning": 2100000, "Pain": 2200000, "Gas": 2300000,
  "Tiger": 5000000, "Yeti": 500000,
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

let stockState = loadCache();

// ── Bron 1: FruityBlox ─────────────────────────────────────────────────────
async function fetchFromFruityBlox() {
  console.log("[FruityBlox] Fetching...");
  try {
    const response = await axios.post(
      "https://fruityblox.com/stock",
      [],
      {
        timeout: 10000,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": "fVf4BAaS1ANg-cLsn4nAM",
          "User-Agent": "Mozilla/5.0",
          "Origin": "https://fruityblox.com",
          "Referer": "https://fruityblox.com/stock",
        }
      }
    );

    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const lines = raw.split("\n");
    let stockData = null;

    for (const line of lines) {
      if (line.includes('"normal"')) {
        const jsonStr = line.replace(/^\d+:/, "");
        stockData = JSON.parse(jsonStr);
        break;
      }
    }

    if (!stockData) {
      console.warn("[FruityBlox] Geen 'normal' gevonden in response.");
      return null;
    }

    const normal = (stockData.normal || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    const mirage = (stockData.mirage || [])
      .filter(f => f.name && f.name !== "Rocket" && f.name !== "Spin")
      .map(f => ({ name: f.name, price: FRUIT_PRICES[f.name] ?? f.price ?? 0 }));

    console.log("[FruityBlox] Normal:", normal.map(f => f.name));
    console.log("[FruityBlox] Mirage:", mirage.map(f => f.name));

    if (normal.length === 0) return null;
    return { normal, mirage };

  } catch (err) {
    console.error("[FruityBlox] Fout:", err.message);
    return null;
  }
}

// ── Bron 2: Wiki (fallback) ────────────────────────────────────────────────
async function fetchFromWiki() {
  console.log("[Wiki] Fetching...");
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );

    const wikitext = response.data?.parse?.wikitext?.["*"] || "";
    console.log("[Wiki] Snippet:", wikitext.slice(0, 300));

    let normalFruits = [];
    let mirageFruits = [];

    const currentMatch = wikitext.match(/\|\s*[Cc]urrent\s*=\s*([^\n|\]]+)/);
    if (currentMatch) {
      normalFruits = currentMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => name && name !== "Rocket" && name !== "Spin" && FRUIT_PRICES[name]);
    }

    const mirageMatch = wikitext.match(/\|\s*[Mm]irage\s*=\s*([^\n|\]]+)/);
    if (mirageMatch) {
      mirageFruits = mirageMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => name && name !== "Rocket" && name !== "Spin" && FRUIT_PRICES[name]);
    }

    console.log("[Wiki] Normal:", normalFruits);
    console.log("[Wiki] Mirage:", mirageFruits);

    if (normalFruits.length === 0) {
      console.warn("[Wiki] Geen fruits gevonden — wiki formaat mogelijk veranderd.");
      return null;
    }

    return {
      normal: normalFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
      mirage: mirageFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
    };

  } catch (err) {
    console.error("[Wiki] Fout:", err.message);
    return null;
  }
}

// ── Stock updater ──────────────────────────────────────────────────────────
async function updateStock() {
  // Probeer FruityBlox eerst, daarna Wiki als fallback
  let stock = await fetchFromFruityBlox();

  if (!stock) {
    console.log("[Updater] FruityBlox mislukt, probeer Wiki...");
    stock = await fetchFromWiki();
  }

  if (!stock) {
    console.error("[Updater] Beide bronnen mislukt. Stock ongewijzigd.");
    return;
  }

  const newStockJSON = JSON.stringify(stock);
  if (JSON.stringify(stockState.current) !== newStockJSON) {
    console.log("[Updater] Nieuwe stock gedetecteerd — geschiedenis bijgewerkt.");
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = stock;
    stockState.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(stockState, null, 2));
  } else {
    console.log("[Updater] Stock ongewijzigd.");
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/stock", (req, res) => {
  res.json(stockState);
});

// Debug: bekijk ruwe wiki tekst
app.get("/api/debug-wiki", async (req, res) => {
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );
    res.json({ wikitext: response.data?.parse?.wikitext?.["*"]?.slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: bekijk ruwe FruityBlox response
app.get("/api/debug-fruityblox", async (req, res) => {
  try {
    const response = await axios.post(
      "https://fruityblox.com/stock",
      [],
      {
        timeout: 10000,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": "fVf4BAaS1ANg-cLsn4nAM",
          "User-Agent": "Mozilla/5.0",
          "Origin": "https://fruityblox.com",
          "Referer": "https://fruityblox.com/stock",
        }
      }
    );
    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    res.json({ raw: raw.slice(0, 3000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clear cache route ──
app.post("/api/clear-cache", (req, res) => {
  try {
    stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log("[Cache] Cache cleared via API");
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Force fetch route ──
app.post("/api/force-fetch", async (req, res) => {
  try {
    await updateStock();
    res.json({ ok: true, message: "Stock fetch completed" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server draait op poort ${PORT}`);
  await updateStock();
  setInterval(updateStock, POLL_INTERVAL_MS);
});
