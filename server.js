const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "stock_cache.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

console.log("TOKEN EXISTS:", !!DISCORD_TOKEN);
console.log("CHANNEL_ID:", CHANNEL_ID);

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

function parseStockEmbed(embeds) {
  const result = { normal: [], mirage: [] };
  if (!embeds || embeds.length === 0) return null;

  const embed = embeds[0];
  const rawText = [
    embed.title || "",
    embed.description || "",
    ...(embed.fields || []).map(f => f.name + " " + f.value),
  ].join("\n");

  // Remove Discord emoji tags and markdown
  const cleanText = rawText
    .replace(/<:[^:]+:\d+>/g, "")
    .replace(/<a:[^:]+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "");

  console.log("CLEAN TEXT:", cleanText.slice(0, 400));

  let currentSection = null;
  for (const line of cleanText.split("\n")) {
    const lower = line.toLowerCase();
    if (lower.includes("normal stock")) { currentSection = "normal"; continue; }
    if (lower.includes("mirage stock")) { currentSection = "mirage"; continue; }
    if (lower.includes("outdated") || lower.includes("refreshes") || lower.includes("stock changes") || lower.includes("add me")) continue;

    if (currentSection) {
      // Supports both formats:
      // "Dark - 500,000" (FruityBlox)
      // "Flame • 250,000" (Bloxy Stocks)
      const match = line.match(/([A-Za-z\-]+)\s*[•\-–]\s*([\d,]+)/);
      if (match) {
        result[currentSection].push({
          name: match[1].trim(),
          price: parseInt(match[2].replace(/,/g, "")),
        });
      }
    }
  }

  if (result.normal.length === 0 && result.mirage.length === 0) return null;
  return result;
}

function stockHasChanged(oldStock, newStock) {
  if (!oldStock) return true;
  if (!newStock) return false;
  return JSON.stringify(oldStock) !== JSON.stringify(newStock);
}

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function fetchStockFromDiscord() {
  console.log(`[${new Date().toISOString()}] Fetching stock from Discord...`);
  try {
    const channel = await discordClient.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error("Channel not found!");
      return;
    }

    const msgs = await channel.messages.fetch({ limit: 20 });
    console.log(`Found ${msgs.size} messages in channel`);

    let latestStock = null;
    let latestTimestamp = 0;

    for (const msg of msgs.values()) {
      if (msg.embeds.length > 0) {
        const parsed = parseStockEmbed(msg.embeds);
        if (parsed && msg.createdTimestamp > latestTimestamp) {
          latestStock = parsed;
          latestTimestamp = msg.createdTimestamp;
        }
      }
    }

    if (!latestStock) {
      console.log("No stock embed found in last 20 messages.");
      return;
    }

    if (!stockHasChanged(stockState.current, latestStock)) {
      console.log("Stock unchanged — skipping.");
      return;
    }

    console.log("New stock detected! Saving...", JSON.stringify(latestStock));
    stockState.beforeLast = stockState.last;
    stockState.last = stockState.current;
    stockState.current = latestStock;
    stockState.lastUpdated = new Date().toISOString();
    saveCache(stockState);

  } catch (err) {
    console.error("Discord fetch failed:", err.message);
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

discordClient.once("clientReady", async () => {
  console.log(`Discord bot logged in as ${discordClient.user.tag}`);
  await fetchStockFromDiscord();
  setInterval(fetchStockFromDiscord, POLL_INTERVAL_MS);
});

discordClient.login(DISCORD_TOKEN).catch(err => {
  console.error("Failed to login to Discord:", err.message);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
