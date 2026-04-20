const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

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
  "Kitsune": 8000000, "Dragon": 10000000,
  "Blade": 600000,
  "Eagle": 650000,
  "Creation": 3000000,
  "Lightning": 2000000,
  "Pain": 2200000,
  "Gas": 2300000,
  "Tiger": 2000000,
  "Yeti": 2100000,
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

let stockState = loadCache();

async function fetchFromWiki() {
  console.log("Fetching from Wiki...");
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
    );

    const wikitext = response.data?.parse?.wikitext?.["*"] || "";
    console.log("Wiki snippet:", wikitext.slice(0, 500)); // Debug: log what we get

    // Try multiple regex patterns to handle wiki formatting variations
    let normalFruits = [];
    let mirageFruits = [];

    // Pattern 1: |Current = Fruit1, Fruit2
    const currentMatch = wikitext.match(/\|\s*[Cc]urrent\s*=\s*([^\n|\]]+)/);
    if (currentMatch) {
      normalFruits = currentMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => FRUIT_PRICES[name]);
    }

    // Pattern 2: |Mirage = Fruit1, Fruit2
    const mirageMatch = wikitext.match(/\|\s*[Mm]irage\s*=\s*([^\n|\]]+)/);
    if (mirageMatch) {
      mirageFruits = mirageMatch[1].split(",")
        .map(s => s.trim().replace(/[^a-zA-Z\-]/g, ""))
        .filter(name => FRUIT_PRICES[name]);
    }

    console.log("Parsed normal:", normalFruits, "| mirage:", mirageFruits);

    if (normalFruits.length === 0) {
      console.warn("No fruits parsed — wiki format may have changed. Raw wikitext logged above.");
      return null;
    }

    return {
      normal: normalFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
      mirage: mirageFruits.map(name => ({ name, price: FRUIT_PRICES[name] })),
    };

  } catch (err) {
    console.error("Wiki fetch error:", err.message);
    return null;
  }
}

async function updateStock() {
  const stock = await fetchFromWiki();
  if (stock) {
    const newStockJSON = JSON.stringify(stock);
    if (JSON.stringify(stockState.current) !== newStockJSON) {
      console.log("New stock detected — updating history.");
      stockState.beforeLast = stockState.last;
      stockState.last = stockState.current;
      stockState.current = stock;
      stockState.lastUpdated = new Date().toISOString();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(stockState, null, 2));
    } else {
      console.log("Stock unchanged.");
    }
  }
}

// Health check route
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.get("/api/stock", (req, res) => res.json(stockState));

// Debug route — lets you see raw wiki text without deploying
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

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await updateStock();
  setInterval(updateStock, POLL_INTERVAL_MS);
});
