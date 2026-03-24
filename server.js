const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const NOTIFICATION_THRESHOLD = 1900000;
const NTFY_URL = "https://ntfy.sh/bloxfruits-stock-xh8c";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {}
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

let stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };
let failCount = 0;

async function sendNotification(title, message, priority, tags) {
  try {
    const result = await axios.post(NTFY_URL, message, {
      headers: {
        "Title": title,
        "Priority": priority || "default",
        "Tags": tags ? tags.join(",") : "",
      },
      timeout: 10000,
    });
    console.log("Notificatie verstuurd:", title, "status:", result.status);
  } catch (err) {
    console.error("Notificatie mislukt:", err.message);
    if (err.response) {
      console.error("Response:", err.response.status, JSON.stringify(err.response.data));
    }
  }
}

function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  if (!newStock) return false;
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

const FRUIT_PRICES = {
  "Rocket": 5000, "Spin": 7500, "Spring": 60000, "Bomb": 80000,
  "Smoke": 100000, "Spike": 180000, "Flame": 250000, "Eagle": 300000,
  "Ice": 350000, "Sand": 420000, "Dark": 500000, "Ghost": 550000,
  "Diamond": 600000, "Light": 650000, "Rubber": 750000, "Creation": 800000,
  "Magma": 850000, "Quake": 1000000, "Buddha": 1200000, "Love": 1300000,
  "Spider": 1500000, "Sound": 1700000, "Phoenix": 1800000, "Portal": 1900000,
  "Lightning": 2100000, "Blizzard": 2400000, "Gravity": 2500000,
  "Mammoth": 2700000, "T-Rex": 2700000, "Dough": 2800000, "Shadow": 2900000,
  "Venom": 3000000, "Gas": 3200000, "Spirit": 3400000, "Tiger": 5000000,
  "Yeti": 5000000, "Kitsune": 8000000, "Control": 9000000, "Dragon": 15000000,
  "Pain": 2700000, "Blade": 30000,
};

async function fetchFromFastAPI() {
  console.log("Trying fast API...");
  try {
    const response = await axios.get(
      "https://blox-fruits-api.onrender.com/api/bloxfruits/stock",
      { timeout: 10000 }
    );
    const data = response.data;
    const items = data.stock || data;
    if (!items || Object.keys(items).length === 0) {
      console.log("Fast API returned empty stock.");
      return null;
    }
    const normal = [];
    for (const [name, info] of Object.entries(items)) {
      const price = typeof info === "object" ? (info.price || info.beliPrice || 0) : info;
      normal.push({ name, price: parseInt(price) || FRUIT_PRICES[name] || 0 });
    }
    console.log("Fast API success:", JSON.stringify(normal));
    return { normal, mirage: [] };
  } catch (err) {
    console.log("Fast API failed:", err.message);
    return null;
  }
}

async function fetchFromWiki() {
  console.log("Trying Fandom Wiki...");
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 BloxFruitsStockTracker/1.0" } }
    );
    const wikitext = response.data?.parse?.wikitext?.["*"] || "";
    const currentMatch = wikitext.match(/\|Current\s*=\s*([^\n|]+)/);
    const lastMatch = wikitext.match(/\|Last\s*=\s*([^\n|]+)/);
    const beforeMatch = wikitext.match(/\|Before\s*=\s*([^\n|]+)/);

    function parseFruits(str) {
      if (!str) return [];
      return str.split(",").map(s => s.trim()).filter(s => s.length > 0)
        .map(name => ({ name, price: FRUIT_PRICES[name] || 0 }));
    }

    const current = parseFruits(currentMatch?.[1]);
    if (current.length === 0) { console.log("Wiki returned empty."); return null; }

    console.log("Wiki success:", JSON.stringify(current));
    return {
      current: { normal: current, mirage: [] },
      last: { normal: parseFruits(lastMatch?.[1]), mirage: [] },
      before: { normal: parseFruits(beforeMatch?.[1]), mirage: [] },
    };
  } catch (err) {
    console.log("Wiki failed:", err.message);
    return null;
  }
}

async function fetchAndUpdateStock() {
  console.log(`[${new Date().toISOString()}] Polling stock...`);

  let newStock = null;
  let fromWiki = false;

  const fastResult = await fetchFromFastAPI();
  if (fastResult) {
    newStock = fastResult;
  } else {
    const wikiResult = await fetchFromWiki();
    if (wikiResult) {
      newStock = wikiResult.current;
      fromWiki = true;
      stockState.last = wikiResult.last;
      stockState.beforeLast = wikiResult.before;
    }
  }

  if (!newStock) {
    failCount++;
    console.log("Both sources failed. Fail count:", failCount);
    if (failCount === 3) {
      await sendNotification(
        "Stock ophalen mislukt",
        "De server kan geen stock data ophalen. Zowel de snelle API als de wiki zijn onbereikbaar.",
        "high",
        ["warning", "rotating_light"]
      );
    }
    return;
  }

  failCount = 0;

  if (!stockHasChanged(stockState.current, newStock)) {
    console.log("Stock unchanged — skipping.");
    if (fromWiki) saveCache(stockState);
    return;
  }

  const allFruits = [...(newStock.normal || []), ...(newStock.mirage || [])];
  const rareFruits = allFruits.filter(f => f.price > NOTIFICATION_THRESHOLD);

  if (rareFruits.length > 0) {
    const fruitList = rareFruits.map(f =>
      f.name + " (" + (f.price / 1000000).toFixed(1) + "M Beli)"
    ).join(", ");
    await sendNotification(
      "Zeldzame fruit in stock!",
      fruitList + " is nu in stock!",
      "urgent",
      ["rotating_light", "tada"]
    );
  }

  console.log("New stock! Saving...");
  stockState.beforeLast = stockState.last;
  stockState.last = stockState.current;
  stockState.current = newStock;
  stockState.lastUpdated = new Date().toISOString();
  saveCache(stockState);
}

app.get("/api/stock", (req, res) => {
  if (!stockState.current) {
    return res.status(503).json({
      error: "Stock data not yet available.",
      lastUpdated: stockState.lastUpdated,
    });
  }
  res.json({
    current: stockState.current,
    last: stockState.last,
    beforeLast: stockState.beforeLast,
    lastUpdated: stockState.lastUpdated,
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    hasData: !!stockState.current,
    lastUpdated: stockState.lastUpdated,
    uptime: Math.floor(process.uptime()) + "s",
    failCount,
  });
});

app.get("/test-notify", async (req, res) => {
  try {
    const result = await axios.post(NTFY_URL, "Test notificatie van Blox Fruits Stock server!", {
      headers: {
        "Title": "Test",
        "Priority": "default",
      },
      timeout: 10000,
    });
    res.json({ success: true, status: result.status });
  } catch (err) {
    res.json({ success: false, error: err.message, response: err.response?.data });
  }
});

app.listen(PORT, async () => {
  console.log("Server running on port", PORT);
  await sendNotification(
    "Server gestart",
    "Blox Fruits Stock server is opgestart en actief!",
    "low",
    ["white_check_mark"]
  );
  await fetchAndUpdateStock();
  setInterval(fetchAndUpdateStock, POLL_INTERVAL_MS);
});
