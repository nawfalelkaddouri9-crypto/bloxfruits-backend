const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const RAPID_API_KEY = "19cc0b9b9bmsh797880eb87d7c2dp103dfajsn74a12bb7c14d";
const RAPID_API_HOST = "blox-fruit-stock-fruit.p.rapidapi.com";

const headers = {
  "x-rapidapi-key": RAPID_API_KEY,
  "x-rapidapi-host": RAPID_API_HOST,
};

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
  return { current: null, last: null, beforeLast: null, lastUpdated: null, values: null };
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
  if (!newStock || Object.keys(newStock).length === 0) {
    console.log(`[${new Date().toISOString()}] Empty stock — ignoring.`);
    return false;
  }
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

async function fetchAndUpdateStock() {
  console.log(`[${new Date().toISOString()}] Polling RapidAPI...`);
  try {
    // Fetch stock and values at the same time
    const [stockRes, valuesRes] = await Promise.all([
      axios.get(`https://${RAPID_API_HOST}/stock`, { headers, timeout: 15000 }),
      axios.get(`https://${RAPID_API_HOST}/fruit`, { headers, timeout: 15000 }),
    ]);

    const newStock = stockRes.data;
    const newValues = valuesRes.data;

    console.log(`[${new Date().toISOString()}] Stock:`, JSON.stringify(newStock).slice(0, 100));
    console.log(`[${new Date().toISOString()}] Values:`, JSON.stringify(newValues).slice(0, 100));

    // Always update values
    stockState.values = newValues;

    if (!stockHasChanged(stockState.current, newStock)) {
      console.log(`[${new Date().toISOString()}] Stock unchanged — skipping.`);
      saveCache(stockState);
      return;
    }

    console.log(`[${new Date().toISOString()}] New stock detected! Saving...`);
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = newStock;
    stockState.lastUpdated = new Date().toISOString();

    saveCache(stockState);
    console.log(`[${new Date().toISOString()}] Updated successfully.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed:`, err.message);
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
    values: stockState.values,
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
  await fetchAndUpdateStock();
  setInterval(fetchAndUpdateStock, POLL_INTERVAL_MS);
});
```

Klik **Commit changes** → wacht 2 minuten → ga dan naar:
```
https://bloxfruits-stock-api-xh8c.onrender.com/api/stock
