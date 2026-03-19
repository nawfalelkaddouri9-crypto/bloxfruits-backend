const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const NOTIFICATION_THRESHOLD = 1900000; // Portal price

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── FCM tokens storage ────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, "fcm_tokens.json");

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    }
  } catch (e) {}
  return [];
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
  } catch (e) {}
}

let fcmTokens = loadTokens();

// ── Cache ─────────────────────────────────────────────────────────────────────
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

let stockState = loadCache();

// ── Firebase FCM ──────────────────────────────────────────────────────────────
let firebaseApp = null;

async function initFirebase() {
  try {
    const admin = require("firebase-admin");
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("Firebase initialized!");
  } catch (err) {
    console.error("Firebase init failed:", err.message);
  }
}

async function sendPushNotification(fruits) {
  if (!firebaseApp || fcmTokens.length === 0) return;
  try {
    const admin = require("firebase-admin");
    const fruitNames = fruits.map(f => `${f.name} (${(f.price/1000000).toFixed(1)}M)`).join(", ");
    const message = {
      notification: {
        title: "🍎 Rare Fruit in Stock!",
        body: `${fruitNames} is now in stock!`,
      },
      android: {
        notification: {
          sound: "default",
          priority: "high",
          channelId: "stock_alerts",
        }
      },
      tokens: fcmTokens,
    };
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`Push sent! Success: ${response.successCount}, Failed: ${response.failureCount}`);

    // Remove invalid tokens
    const validTokens = [];
    response.responses.forEach((resp, idx) => {
      if (resp.success) validTokens.push(fcmTokens[idx]);
    });
    fcmTokens = validTokens;
    saveTokens(fcmTokens);
  } catch (err) {
    console.error("Push notification failed:", err.message);
  }
}

// ── Stock helpers ─────────────────────────────────────────────────────────────
function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  if (!newStock) return false;
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

const FRUIT_PRICES = {
  "Blade": 30000, "Smoke": 100000, "Sand": 420000, "Magma": 850000,
  "Creation": 1400000, "Phoenix": 1400000, "Eagle": 75000, "Ghost": 0,
  "Spike": 180000, "Dark": 500000, "Ice": 350000, "Rubber": 750000,
  "Flame": 250000, "Light": 650000, "Bomb": 80000, "Rocket": 5000,
  "Spin": 7500, "Portal": 1900000, "Barrier": 800000, "Quake": 1000000,
  "Buddha": 1200000, "Love": 1200000, "Spider": 1500000, "Sound": 1800000,
  "Paw": 2300000, "Gravity": 2500000, "Mammoth": 2700000, "Shadow": 2900000,
  "Venom": 3000000, "Control": 3200000, "Blizzard": 2500000, "Dragon": 3500000,
  "Leopard": 5000000, "Kitsune": 0, "T-Rex": 0, "Human": 0,
  "Chop": 30000, "Spring": 60000, "Kilo": 5000, "Falcon": 75000,
  "Diamond": 600000, "Revive": 0,
};

// ── Source 1: Fast API ────────────────────────────────────────────────────────
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

// ── Source 2: Fandom Wiki ─────────────────────────────────────────────────────
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

// ── Main fetch + notification logic ──────────────────────────────────────────
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

      // Update last/before from wiki regardless
      stockState.last = wikiResult.last;
      stockState.beforeLast = wikiResult.before;
    }
  }

  if (!newStock) {
    console.log("Both sources failed — keeping cache.");
    return;
  }

  if (!stockHasChanged(stockState.current, newStock)) {
    console.log("Stock unchanged — skipping.");
    if (fromWiki) saveCache(stockState);
    return;
  }

  // Check for rare fruits (more expensive than Portal)
  const allFruits = [...(newStock.normal || []), ...(newStock.mirage || [])];
  const rareFruits = allFruits.filter(f => f.price > NOTIFICATION_THRESHOLD);

  if (rareFruits.length > 0) {
    console.log("Rare fruits detected!", rareFruits.map(f => f.name).join(", "));
    await sendPushNotification(rareFruits);
  }

  console.log("New stock! Saving...");
  stockState.beforeLast = stockState.last;
  stockState.last = stockState.current;
  stockState.current = newStock;
  stockState.lastUpdated = new Date().toISOString();
  saveCache(stockState);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Register FCM token from Android app
app.post("/api/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });
  if (!fcmTokens.includes(token)) {
    fcmTokens.push(token);
    saveTokens(fcmTokens);
    console.log(`New FCM token registered. Total: ${fcmTokens.length}`);
  }
  res.json({ success: true });
});

app.get("/api/stock", (req, res) => {
  if (!stockState.current) {
    return res.status(503).json({ error: "Stock data not yet available." });
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
    tokens: fcmTokens.length,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initFirebase();
  await fetchAndUpdateStock();
  setInterval(fetchAndUpdateStock, POLL_INTERVAL_MS);
});
