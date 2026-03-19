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
  console.log(`[${new Date().toISOString()}] Fetching from FruityBlox API...`);
  try {
    // Try the Next.js API route that FruityBlox uses internally
    const response = await axios.get("https://fruityblox.com/api/stock", {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://fruityblox.com/stock",
      }
    });

    console.log("Response status:", response.status);
    console.log("Response data:", JSON.stringify(response.data).slice(0, 500));

    const data = response.data;
    const result = { normal: [], mirage: [] };

    // Parse whatever format FruityBlox returns
    if (Array.isArray(data)) {
      for (const item of data) {
        const name = item.name || item.fruit || item.title;
        const price = item.price || item.beliPrice || item.beli;
        const type = item.type || item.dealer || "";
        if (name && price) {
          if (type.toLowerCase().includes("mirage")) {
            result.mirage.push({ name, price: parseInt(price) });
          } else {
            result.normal.push({ name, price: parseInt(price) });
          }
        }
      }
    } else if (data.normal || data.mirage) {
      result.normal = data.normal || [];
      result.mirage = data.mirage || [];
    }

    console.log("Parsed:", JSON.stringify(result));

    if (result.normal.length === 0 && result.mirage.length === 0) {
      console.log("No fruits found in API response.");
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
      console.error("Data:", JSON.stringify(err.response.data).slice(0, 200));
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
