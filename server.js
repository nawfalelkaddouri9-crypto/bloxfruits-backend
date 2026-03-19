const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to read cache:", e.message);
  }
  return { current: null, last: null, beforeLast: null, lastUpdated: null };
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to write cache:", e.message);
  }
}

let stockState = { current: null, last: null, beforeLast: null, lastUpdated: null };

function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  if (!newStock) return false;
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

async function fetchAndUpdateStock() {
  console.log(`[${new Date().toISOString()}] Fetching from Fandom API...`);
  try {
    const response = await axios.get(
      "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
      {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 BloxFruitsStockTracker/1.0",
        }
      }
    );

    const wikitext = response.data?.parse?.wikitext?.["*"] || "";
    console.log("Wikitext sample:", wikitext.slice(0, 500));

    const result = { normal: [], mirage: [] };

    // Parse wiki table format
    const lines = wikitext.split("\n");
    let currentSection = null;

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes("normal") && lower.includes("stock")) { currentSection = "normal"; continue; }
      if (lower.includes("mirage") && lower.includes("stock")) { currentSection = "mirage"; continue; }

      if (currentSection) {
        // Wiki format: | FruitName || price
        const match = line.match(/\|\s*([A-Za-z\s\-]+)\s*\|\|\s*([\d,]+)/);
        if (match) {
          const name = match[1].trim();
          const price = parseInt(match[2].replace(/,/g, ""));
          if (name && price > 0) {
            result[currentSection].push({ name, price });
          }
        }
      }
    }

    console.log("Parsed:", JSON.stringify(result));

    if (result.normal.length === 0 && result.mirage.length === 0) {
      console.log("No fruits found in wiki.");
      return;
    }

    if (!stockHasChanged(stockState.current, result)) {
      console.log("Stock unchanged — skipping.");
      return;
    }

    console.log("New stock detected! Saving...");
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = result;
    stockState.lastUpdated = new Date().toISOString();
    saveCache(stockState);

  } catch (err) {
    console.error("Fetch failed:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
    }
  }
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
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await fetchAndUpdateStock();
  setInterval(fetchAndUpdateStock, POLL_INTERVAL_MS);
});
