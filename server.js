/**
 * Powerball Winner Alerts — Backend Server
 * - Manages all registered users and their tickets
 * - Checks Powerball results every Mon, Wed & Sat night
 * - Texts users ONLY when they win
 * - Powerball: 5 numbers (1-69) + 1 Powerball (1-26)
 */

const express = require("express");
const twilio = require("twilio");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.json());

// ─── YOUR TWILIO CREDENTIALS ──────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── USER DATABASE ────────────────────────────────────────────────────────────
const DB_FILE = "./users.json";

function loadUsers() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// ─── POWERBALL PRIZE TABLE ────────────────────────────────────────────────────
const PRIZES = {
  "5+1": "JACKPOT",
  "5+0": 1000000,
  "4+1": 50000,
  "4+0": 100,
  "3+1": 100,
  "3+0": 7,
  "2+1": 7,
  "1+1": 4,
  "0+1": 4,
};

// ─── CHECK ONE TICKET ─────────────────────────────────────────────────────────
function checkTicket(ticket, draw) {
  const matched = ticket.numbers.filter(n => draw.numbers.includes(n)).length;
  const pbMatch = ticket.powerball === draw.powerball;
  const key = `${matched}+${pbMatch ? 1 : 0}`;
  const prize = PRIZES[key] || 0;
  return { matched, pbMatch, prize, key };
}

// ─── FETCH POWERBALL RESULTS ──────────────────────────────────────────────────
async function fetchLatestDrawing() {
  try {
    const url = "https://data.ny.gov/resource/d6yy-54nr.json?$limit=1&$order=draw_date+DESC";
    const res = await axios.get(url, { timeout: 10000 });
    const draw = res.data[0];
    const allNums = draw.winning_numbers.split(" ").map(Number);
    return {
      numbers: allNums.slice(0, 5),
      powerball: allNums[5],
      date: draw.draw_date,
    };
  } catch (err) {
    console.error("Could not fetch Powerball results:", err.message);
    throw err;
  }
}

// ─── BUILD WIN SMS ────────────────────────────────────────────────────────────
function buildWinMessage(draw, ticketResults, totalWon, hasJackpot) {
  const date = new Date(draw.date).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric"
  });
  const winningNums = `${draw.numbers.join("-")} PB:${draw.powerball}`;

  const lines = ticketResults
    .map((r, i) => {
      if (!r.prize) return null;
      if (r.prize === "JACKPOT") return `  Ticket ${i+1}: 🎰 JACKPOT WINNER!`;
      return `  Ticket ${i+1}: +$${r.prize.toLocaleString()} (${r.matched} match${r.pbMatch ? "+PB" : ""})`;
    })
    .filter(Boolean);

  const summary = hasJackpot
    ? "🎰 YOU HIT THE JACKPOT! Contact your state lottery immediately!"
    : `Total: $${totalWon.toLocaleString()} 🏆`;

  return [
    `🔴 YOU WON! Powerball — ${date}`,
    `Winning: ${winningNums}`,
    ``,
    lines.join("\n"),
    ``,
    summary,
    `Check your tickets to claim your prize!`,
  ].join("\n");
}

// ─── SEND SMS ─────────────────────────────────────────────────────────────────
async function sendSms(toPhone, message) {
  return client.messages.create({
    body: message,
    from: TWILIO_FROM_NUMBER,
    to: `+1${toPhone}`,
  });
}

// ─── MAIN: CHECK ALL USERS ────────────────────────────────────────────────────
async function checkAllUsersAndNotify() {
  console.log(`\n[${new Date().toLocaleString()}] Checking Powerball results...`);

  let draw;
  try {
    draw = await fetchLatestDrawing();
    console.log(`Draw: ${draw.numbers.join("-")} PB:${draw.powerball} (${draw.date})`);
  } catch (err) {
    console.error("Could not fetch results:", err.message);
    return;
  }

  const users = loadUsers();
  const phones = Object.keys(users);
  console.log(`Checking ${phones.length} registered users...`);

  let winnersCount = 0;

  for (const phone of phones) {
    const user = users[phone];
    if (!user.active) continue;

    const ticketResults = user.tickets.map(t => checkTicket(t, draw));
    const totalWon = ticketResults.reduce((s, r) => {
      if (!r.prize || r.prize === "JACKPOT") return s;
      return s + r.prize;
    }, 0);
    const hasJackpot = ticketResults.some(r => r.prize === "JACKPOT");

    if (totalWon > 0 || hasJackpot) {
      try {
        const message = buildWinMessage(draw, ticketResults, totalWon, hasJackpot);
        await sendSms(phone, message);
        console.log(`✓ Texted winner: ***${phone.slice(-4)} — won $${totalWon}${hasJackpot ? " + JACKPOT!" : ""}`);
        winnersCount++;
      } catch (err) {
        console.error(`Failed to text ${phone.slice(-4)}:`, err.message);
      }
    }
  }

  console.log(`Done. ${winnersCount} winner(s) notified out of ${phones.length} users.`);
}

// ─── SCHEDULE: Mon, Wed, Sat at 11 PM Eastern ─────────────────────────────────
// Powerball drawing is at 10:59 PM ET — results posted shortly after
cron.schedule("0 23 * * 1,3,6", checkAllUsersAndNotify, {
  timezone: "America/New_York"
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.post("/register", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  users[phone] = { tickets, registeredAt: new Date().toISOString(), active: true };
  saveUsers(users);
  console.log(`New user registered: ***${phone.slice(-4)} with ${tickets.length} ticket(s)`);
  res.json({ success: true, message: "Registered! You'll be texted only when you win." });
});

app.post("/update-tickets", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  if (!users[phone]) {
    return res.status(404).json({ error: "Phone not registered. Please register first." });
  }
  users[phone].tickets = tickets;
  users[phone].updatedAt = new Date().toISOString();
  saveUsers(users);
  res.json({ success: true, message: "Tickets updated!" });
});

app.post("/cancel", (req, res) => {
  const { phone } = req.body;
  const users = loadUsers();
  if (users[phone]) {
    users[phone].active = false;
    saveUsers(users);
  }
  res.json({ success: true });
});

app.get("/check-now", async (req, res) => {
  res.json({ status: "Checking Powerball results now — winners will be texted shortly!" });
  await checkAllUsersAndNotify();
});

app.get("/stats", (req, res) => {
  const users = loadUsers();
  const active = Object.values(users).filter(u => u.active).length;
  res.json({
    totalUsers: Object.keys(users).length,
    activeSubscribers: active,
    estimatedAnnualRevenue: `$${(active * 2.54).toFixed(2)}`,
  });
});

app.get("/privacy", (req, res) => {
  const path = require("path");
  res.sendFile(path.join(__dirname, "privacy.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "running", schedule: "Mon, Wed & Sat at 11 PM ET" });
});

app.listen(3000, () => {
  console.log("Powerball Winner Alerts server running on port 3000");
  console.log("Schedule: Monday, Wednesday & Saturday at 11 PM Eastern");
  console.log("Test: http://localhost:3000/check-now");
});
