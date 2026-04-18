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
    "Rocket": 5000, "Spin": 7500, "Spring": 60000, "Bomb": 80000, "Smoke": 100000,
    "Spike": 180000, "Flame": 250000, "Ice": 350000, "Sand": 420000, "Dark": 500000,
    "Ghost": 550000, "Diamond": 600000, "Light": 650000, "Rubber": 750000, "Magma": 850000,
    "Quake": 1000000, "Buddha": 1200000, "Love": 1300000, "Spider": 1500000, "Sound": 1700000,
    "Phoenix": 1800000, "Portal": 1900000, "Rumble": 2100000, "Blizzard": 2400000,
    "Gravity": 2500000, "Mammoth": 2700000, "T-Rex": 2700000, "Dough": 2800000,
    "Shadow": 2900000, "Venom": 3000000, "Control": 3200000, "Spirit": 3400000,
    "Leopard": 5000000, "Kitsune": 8000000, "Dragon": 10000000
};

let stockState = { current: null, last: null, lastUpdated: null };

async function fetchFromWiki() {
    console.log("Checking Wiki...");
    try {
        const response = await axios.get(
            "https://blox-fruits.fandom.com/api.php?action=parse&page=Blox_Fruits_%22Stock%22&prop=wikitext&format=json",
            { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 Tracker/1.0" } }
        );
        const wikitext = response.data?.parse?.wikitext?.["*"] || "";
        const currentMatch = wikitext.match(/\|Current\s*=\s*([^\n|]+)/);
        if (!currentMatch) return null;

        const fruits = currentMatch[1].split(",").map(s => s.trim()).filter(name => FRUIT_PRICES[name]); 

        // Als er minder dan 3 vruchten zijn, negeren we de update (veiligheid)
        if (fruits.length < 3) return null;

        return fruits.map(name => ({ name, price: FRUIT_PRICES[name] }));
    } catch (err) { return null; }
}

async function updateStock() {
    console.log(`[${new Date().toISOString()}] Polling...`);
    let newStock = await fetchFromWiki();

    if (newStock) {
        const isChanged = JSON.stringify(stockState.current) !== JSON.stringify(newStock);
        if (isChanged) {
            stockState.last = stockState.current;
            stockState.current = newStock;
            stockState.lastUpdated = new Date().toISOString();
            console.log("Stock geüpdatet!");
        }
    }
}

app.get("/api/stock", (req, res) => res.json(stockState));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, async () => {
    console.log(`Server draait op poort ${PORT}`);
    await updateStock();
    setInterval(updateStock, POLL_INTERVAL_MS);
});
