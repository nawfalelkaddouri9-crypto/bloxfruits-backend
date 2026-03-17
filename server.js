const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const BLOX_API_URL = "https://blox-fruits-api.onrender.com/api/bloxfruits/stock";
const POLL_INTERVAL_MS = 2 * 60 * 1000; // poll every 2 minutes

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

let stockState = loadCache();

function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  const items = newStock.stock || newStock;
  if (Object.keys(items).length === 0) {
    console.log(`[${new Date().toISOString()}] API returned empty stock — ignoring.`);
    return false;
  }
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

async function fetchAndUpdateStock() {
  console.log(`[${new Date().toISOString()}] Polling Blox Fruits API...`);
  try {
    const response = await axios.get(BLOX_API_URL, { timeout: 15000 });
    const newStock = response.data;
    if (!stockHasChanged(stockState.current, newStock)) {
      console.log(`[${new Date().toISOString()}] Stock unchanged — skipping update.`);
      return;
    }
    console.log(`[${new Date().toISOString()}] New stock detected! Saving...`);
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = newStock;
    stockState.lastUpdated = new Date().toISOString();
    saveCache(stockState);
    console.log(`[${new Date().toISOString()}] Stock updated successfully.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to fetch stock:`, err.message);
  }
}

app.get("/api/stock", (req, res) => {
  if (!stockState.current) {
    return res.status(503).json({
      error: "Stock data not yet available. Please try again shortly.",
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
  console.log(`Blox Fruits Stock Server running on port ${PORT}`);
  console.log(`Polling every 10 minutes for stock changes.`);
  await fetchAndUpdateStock();
  setInterval(fetchAndUpdateStock, POLL_INTERVAL_MS);
});
