const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();

// ====== BASIC APP HARDENING ======
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "50kb" }));

// ====== MONGODB CONNECTION ======
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.warn("⚠️ MONGO_URI is missing. Add it in Render Environment Variables.");
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log("MongoDB connected ✅"))
    .catch((err) => console.error("MongoDB connection error:", err));
}

mongoose.connection.on("error", (err) => {
  console.error("MongoDB runtime error:", err);
});

// ====== CORS ======
// Optional: set Render env var ALLOWED_ORIGIN to your web origin if you need strict CORS.
// Mobile apps often send no Origin header, so requests without Origin are allowed.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// Lightweight security headers without extra packages
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const PORT = process.env.PORT || 3000;

// ====== MONGODB MODELS ======
const FeedCardSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    tradeId: { type: String, required: true, unique: true, index: true },
    pair: { type: String, required: true, index: true },
    sessionLabel: { type: String, default: "Unknown" },
    direction: { type: String, enum: ["BUY", "SELL"], required: true },
    result: {
      type: String,
      enum: ["WIN", "LOSS", "BREAKEVEN", "OPEN"],
      default: "OPEN",
      index: true
    },
    entryPrice: { type: Number, default: 0 },
    exitPrice: { type: Number, default: 0 },
    pnl: { type: Number, default: 0 },
    tradeTime: { type: Date, default: Date.now, index: true },
    displayName: { type: String, default: "Pre-Billionarie" },
    emojiAvatar: { type: String, default: "🚀" },
    loveCount: { type: Number, default: 0 },
    heartbreakCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

const ReactionSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    card_id: { type: String, required: true, index: true },
    reaction_type: {
      type: String,
      enum: ["love", "heartbreak"],
      required: true
    }
  },
  { timestamps: true }
);

ReactionSchema.index({ user_id: 1, card_id: 1 }, { unique: true });

const ShareLogSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, index: true },
    day: { type: String, required: true, index: true },
    count: { type: Number, default: 0 }
  },
  { timestamps: true }
);

ShareLogSchema.index({ user_id: 1, day: 1 }, { unique: true });

const UserEmojiSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, unique: true, index: true },
    emoji: { type: String, required: true }
  },
  { timestamps: true }
);

const FeedCard = mongoose.model("FeedCard", FeedCardSchema);
const Reaction = mongoose.model("Reaction", ReactionSchema);
const ShareLog = mongoose.model("ShareLog", ShareLogSchema);
const UserEmoji = mongoose.model("UserEmoji", UserEmojiSchema);

// ====== ROOT / HEALTH ======
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

app.get("/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];

  res.json({
    ok: true,
    uptime: process.uptime(),
    mongo: states[mongoose.connection.readyState] || "unknown"
  });
});

// ====== IN-MEMORY RATE LIMITING ======
// This can stay in memory because it is only temporary protection, not app data.
const requestBuckets = {};
const RATE_WINDOW_MS = 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

function isRateLimited(key, maxHits, windowMs = RATE_WINDOW_MS) {
  const now = Date.now();
  const bucket = requestBuckets[key];

  if (!bucket || now - bucket.windowStart > windowMs) {
    requestBuckets[key] = { count: 1, windowStart: now };
    return false;
  }

  if (bucket.count >= maxHits) {
    return true;
  }

  bucket.count += 1;
  return false;
}

function cleanupOldRateLimits() {
  const now = Date.now();
  for (const key of Object.keys(requestBuckets)) {
    if (now - requestBuckets[key].windowStart > RATE_WINDOW_MS * 2) {
      delete requestBuckets[key];
    }
  }
}

setInterval(cleanupOldRateLimits, 10 * 60 * 1000).unref();

// ====== EMOJI SYSTEM ======
const emojiPool = ["🔥", "🚀", "💎", "⚡", "🐼", "🦊", "🐯", "🐸", "🐵", "🐧", "🌙", "⭐", "🌊", "🍀"];

async function getEmoji(userId) {
  const safeUserId = normalizeString(userId, "anon", 100);
  const existing = await UserEmoji.findOne({ user_id: safeUserId }).lean();

  if (existing && existing.emoji) {
    return existing.emoji;
  }

  const emoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];

  try {
    await UserEmoji.create({ user_id: safeUserId, emoji });
  } catch (_) {
    const createdByRace = await UserEmoji.findOne({
      user_id: safeUserId
    }).lean();
    return createdByRace?.emoji || emoji;
  }

  return emoji;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ====== HELPERS ======
const VALID_DIRECTIONS = new Set(["BUY", "SELL"]);
const VALID_RESULTS = new Set(["WIN", "LOSS", "BREAKEVEN", "OPEN"]);
const VALID_REACTIONS = new Set(["love", "heartbreak"]);

function normalizeString(value, fallback = "", maxLength = 50) {
  const result = String(value ?? fallback).trim();
  if (!result) return fallback;
  return result.slice(0, maxLength);
}

function readNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function readTradeTime(value) {
  const raw = normalizeString(value, new Date().toISOString(), 100);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function cardToClient(card, userReaction = "") {
  const tradeTime = card.tradeTime instanceof Date ? card.tradeTime : new Date(card.tradeTime);

  return {
    id: card.id,
    tradeId: card.tradeId,
    pair: card.pair,
    sessionLabel: card.sessionLabel,
    direction: card.direction,
    result: card.result,
    entryPrice: card.entryPrice,
    exitPrice: card.exitPrice,
    pnl: card.pnl,
    tradeTime:
    Number.isNaN(tradeTime.getTime()) ? 
    new Date().toISOString() : 
    tradeTime.toISOString(),
    displayName: card.displayName || "Pre-Billionarie",
    emojiAvatar: card.emojiAvatar || "🚀",
    loveCount: card.loveCount || 0,
    heartbreakCount: card.heartbreakCount || 0,
    userReaction
  };
}

function validateShareTradePayload(data) {
  const tradeId = normalizeString(data.trade_id || data.tradeId, "", 100);
  const userId = normalizeString(data.user_id, "anon", 100);
  const pair = normalizeString(data.pair || data.symbol, "", 30).toUpperCase();
  const sessionLabel = normalizeString(data.session_label || data.sessionLabel, "Unknown", 50);
  const direction = normalizeString(data.direction || data.side, "BUY", 10).toUpperCase();
  const result = normalizeString(data.result, "OPEN", 15).toUpperCase();

  const entryPrice = readNumber(data.entry_price ?? data.entryPrice, 0);
  const exitPrice = readNumber(data.exit_price ?? data.exitPrice, 0);
  const pnl = readNumber(data.pnl ?? data.pnl_amount ?? data.profit, 0);
  const tradeTime = readTradeTime(
    data.trade_time || data.tradeTime || data.shared_at || data.created_at || new Date().toISOString()
  );

  if (!tradeId) {
    return { ok: false, error: "Missing tradeId" };
  }

  if (!userId) {
    return { ok: false, error: "Missing user_id" };
  }

  if (!pair) {
    return { ok: false, error: "Missing pair" };
  }

  if (!VALID_DIRECTIONS.has(direction)) {
    return { ok: false, error: "Invalid direction" };
  }

  if (!VALID_RESULTS.has(result)) {
    return { ok: false, error: "Invalid result" };
  }

  if (entryPrice <= 0 || exitPrice <= 0) {
    return { ok: false, error: "Invalid entry/exit price" };
  }

  return {
    ok: true,
    value: {
      tradeId,
      userId,
      pair,
      sessionLabel,
      direction,
      result,
      entryPrice,
      exitPrice,
      pnl,
      tradeTime
    }
  };
}

function validateReactionPayload(data) {
  const userId = normalizeString(data.user_id, "", 100);
  const cardId = normalizeString(data.card_id, "", 100);
  const reactionType = normalizeString(data.reaction_type, "", 20).toLowerCase();

  if (!userId) return { ok: false, error: "Missing user_id" };
  if (!cardId) return { ok: false, error: "Missing card_id" };
  if (!VALID_REACTIONS.has(reactionType)) {
    return { ok: false, error: "Invalid reaction_type" };
  }

  return {
    ok: true,
    value: { userId, cardId, reactionType }
  };
}

async function recalcReactionCounts(cardId) {
  const [loveCount, heartbreakCount] = await Promise.all([
    Reaction.countDocuments({ card_id: cardId, reaction_type: "love" }),
    Reaction.countDocuments({
      card_id: cardId,
      reaction_type: "heartbreak"
    })
  ]);

  const updatedCard = await FeedCard.findOneAndUpdate(
    { id: cardId },
    { loveCount, heartbreakCount },
    { new: true }
  ).lean();

  return updatedCard;
}

async function getUserReactionMap(userId, cardIds) {
  if (!userId || cardIds.length === 0) return new Map();

  const reactions = await Reaction.find({
    user_id: userId,
    card_id: { $in: cardIds }
  }).lean();

  return new Map(reactions.map((reaction) => [reaction.card_id, reaction.reaction_type]));
}

// ====== REQUEST LOGGING ======
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ip=${getClientIp(req)}`);
  next();
});

// ====== GET FEED ======
app.get("/api/feed/cards", async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (isRateLimited(`feed:${ip}`, 120)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const limit = Math.max(1, Math.min(50, readNumber(req.query.limit, 50)));
    const userId = normalizeString(req.query.user_id, "", 100);

    const cards = await FeedCard.find({}).sort({ tradeTime: -1, createdAt: -1 }).limit(limit).lean();

    const reactionMap = await getUserReactionMap(
      userId,
      cards.map((card) => card.id)
    );

    const items = cards.map((card) => cardToClient(card, reactionMap.get(card.id) || ""));

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

// ====== SHARE TRADE ======
app.post("/api/feed/share-trade", async (req, res, next) => {
  try {
    const ip = getClientIp(req);

    if (isRateLimited(`share:${ip}`, 20)) {
      return res.status(429).json({ error: "Too many share attempts. Please slow down." });
    }

    const validation = validateShareTradePayload(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const data = validation.value;
    const todayKey = getTodayKey();

    const shareLog = await ShareLog.findOneAndUpdate(
      { user_id: data.userId, day: todayKey },
      { $setOnInsert: { count: 0 } },
      { upsert: true, new: true }
    );

    if ((shareLog.count || 0) >= 3) {
      return res.status(400).json({ error: "Daily share limit reached (3 per day)" });
    }

    const exists = await FeedCard.findOne({ tradeId: data.tradeId }).lean();
    if (exists) {
      return res.status(400).json({ error: "Already shared" });
    }

    const newCardData = {
      id: "card_" + Date.now() + "_" + Math.floor(Math.random() * 100000),
      tradeId: data.tradeId,
      pair: data.pair,
      sessionLabel: data.sessionLabel,
      direction: data.direction,
      result: data.result,
      entryPrice: data.entryPrice,
      exitPrice: data.exitPrice,
      pnl: data.pnl,
      tradeTime: data.tradeTime,
      displayName: "Pre-Billionarie",
      emojiAvatar: await getEmoji(data.userId),
      loveCount: 0,
      heartbreakCount: 0
    };

    const createdCard = await FeedCard.create(newCardData);

    await ShareLog.updateOne({ user_id: data.userId, day: todayKey }, { $inc: { count: 1 } });

    return res.json(cardToClient(createdCard.toObject(), ""));
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({ error: "Already shared" });
    }
    return next(err);
  }
});

// ====== REACT ======
app.post("/api/feed/react", async (req, res, next) => {
  try {
    const ip = getClientIp(req);

    if (isRateLimited(`react:${ip}`, 60)) {
      return res.status(429).json({ error: "Too many reaction attempts. Please slow down." });
    }

    const validation = validateReactionPayload(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const { userId, cardId, reactionType } = validation.value;

    const card = await FeedCard.findOne({ id: cardId }).lean();
    if (!card) {
      return res.status(404).json({ error: "Card not found" });
    }

    const existingReaction = await Reaction.findOne({
      user_id: userId,
      card_id: cardId
    }).lean();

    if (existingReaction && existingReaction.reaction_type === reactionType) {
      await Reaction.deleteOne({ user_id: userId, card_id: cardId });
      const updatedCard = await recalcReactionCounts(cardId);

      return res.json({
        success: true,
        removed: true,
        loveCount: updatedCard?.loveCount || 0,
        heartbreakCount: updatedCard?.heartbreakCount || 0,
        item: updatedCard ? cardToClient(updatedCard, "") : null
      });
    }

    await Reaction.findOneAndUpdate(
      { user_id: userId, card_id: cardId },
      { reaction_type: reactionType },
      { upsert: true, new: true }
    );

    const updatedCard = await recalcReactionCounts(cardId);

    return res.json({
      success: true,
      removed: false,
      loveCount: updatedCard?.loveCount || 0,
      heartbreakCount: updatedCard?.heartbreakCount || 0,
      item: updatedCard ? cardToClient(updatedCard, reactionType) : null
    });
  } catch (err) {
    return next(err);
  }
});

// ====== ERROR HANDLERS ======
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);

  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (err && err.name === "ValidationError") {
    return res.status(400).json({ error: "Invalid request data" });
  }

  return res.status(500).json({ error: "Internal server error" });
});

// ====== START SERVER ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
