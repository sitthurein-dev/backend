const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();


// ====== AI API KEY SETUP ======
// Add more keys in Render using these names and the server will auto-use them:
// GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3...
// OPENROUTER_API_KEY, OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3...
// GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3...
function collectEnvKeys(baseName) {
  const keys = [];
  const seen = new Set();

  function add(value) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  }

  add(process.env[baseName]);

  for (let i = 2; i <= 20; i += 1) {
    add(process.env[`${baseName}_${i}`]);
  }

  return keys;
}

const GEMINI_API_KEYS = collectEnvKeys("GEMINI_API_KEY");
const OPENROUTER_API_KEYS = collectEnvKeys("OPENROUTER_API_KEY");
const GROQ_API_KEYS = collectEnvKeys("GROQ_API_KEY");

if (GEMINI_API_KEYS.length === 0) {
  console.warn("⚠️ No Gemini keys found. Add GEMINI_API_KEY or GEMINI_API_KEY_2 in Render Environment Variables.");
}
if (OPENROUTER_API_KEYS.length === 0) {
  console.warn("⚠️ No OpenRouter keys found. Add OPENROUTER_API_KEY or OPENROUTER_API_KEY_2 in Render Environment Variables.");
}
if (GROQ_API_KEYS.length === 0) {
  console.warn("⚠️ No Groq keys found. Add GROQ_API_KEY or GROQ_API_KEY_2 in Render Environment Variables.");
}

console.log(`AI keys loaded: Gemini=${GEMINI_API_KEYS.length}, OpenRouter=${OPENROUTER_API_KEYS.length}, Groq=${GROQ_API_KEYS.length}`);


// ====== BASIC APP HARDENING ======
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "300kb" }));

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
    heartbreakCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 }
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


const CommentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    card_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true, index: true },
    emojiAvatar: { type: String, default: "🚀" },
    text: { type: String, required: true, maxlength: 120 }
  },
  { timestamps: true }
);

CommentSchema.index({ user_id: 1, card_id: 1, text: 1 });

const FeedCard = mongoose.model("FeedCard", FeedCardSchema);
const Reaction = mongoose.model("Reaction", ReactionSchema);
const ShareLog = mongoose.model("ShareLog", ShareLogSchema);
const UserEmoji = mongoose.model("UserEmoji", UserEmojiSchema);
const FeedComment = mongoose.model("Comment", CommentSchema);

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
const emojiPool = [
  "🔥", "🚀", "💎", "⚡", "🌊", "🌙", "⭐", "☀️", "🌈", "❄️",
  "🐼", "🦊", "🐯", "🐸", "🐵", "🐧", "🦁", "🐨", "🐻", "🐺",
  "🧠", "👀", "💡", "🎯", "📈", "📉", "💰", "🪙", "🏆", "🥇",
  "😎", "🤖", "😈", "🥶", "😤", "🤯", "🫡", "🥷", "👑", "💥",
  "🍀", "🍎", "🍕", "🍩", "☕", "🥤", "🍉", "🍇", "🍓", "🍔",
  "🎮", "🎧", "🎤", "🎬", "🎨", "🕹️", "📱", "💻", "⌚", "📊"
];

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

const FIXED_COMMENTS = new Set([
  "Nice one 👏",
  "Clean execution 🔥",
  "That was disciplined.",
  "Good patience paid off.",
  "Well managed trade.",
  "Solid setup.",
  "Respect the plan 💪",
  "That entry was clean.",
  "Good control.",
  "Keep that process.",
  "Don't worry, next one will be better.",
  "Losses are part of the game.",
  "Still in the game 💪",
  "Good lesson here.",
  "Reset and come back clean.",
  "One loss does not define you.",
  "Keep following the process.",
  "It happens. Next trade.",
  "Protect the mindset.",
  "Review it, then let it go.",
  "Interesting setup.",
  "Clean chart.",
  "Good review.",
  "Step by step.",
  "Stay consistent.",
  "Nice idea.",
  "Keep going.",
  "Focus on the process.",
  "Solid discipline.",
  "Trade clean."
]);


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
  let tradeTime = card.tradeTime;

  if (!(tradeTime instanceof Date)) {
    tradeTime = new Date(tradeTime);
  }

  if (Number.isNaN(tradeTime.getTime())) {
    tradeTime = new Date();
  }

  const tradeTimeIso = tradeTime.toISOString();

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
    tradeTime: tradeTimeIso,
    displayName: card.displayName || "Pre-Billionarie",
    emojiAvatar: card.emojiAvatar || "🚀",
    loveCount: card.loveCount || 0,
    heartbreakCount: card.heartbreakCount || 0,
    commentCount: card.commentCount || 0,
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

function validateCommentPayload(data) {
  const userId = normalizeString(data.user_id, "", 100);
  const cardId = normalizeString(data.card_id, "", 100);
  const commentText = normalizeString(data.comment_text || data.text, "", 120);

  if (!userId) return { ok: false, error: "Missing user_id" };
  if (!cardId) return { ok: false, error: "Missing card_id" };
  if (!commentText) return { ok: false, error: "Missing comment_text" };
  if (!FIXED_COMMENTS.has(commentText)) {
    return { ok: false, error: "Invalid comment. Please use a quick comment." };
  }

  return { ok: true, value: { userId, cardId, commentText } };
}

function commentToClient(comment) {
  let createdAt = comment.createdAt;

  if (!(createdAt instanceof Date)) {
    createdAt = new Date(createdAt);
  }

  if (Number.isNaN(createdAt.getTime())) {
    createdAt = new Date();
  }

  const createdAtIso = createdAt.toISOString();

  return {
    id: comment.id,
    cardId: comment.card_id,
    userId: comment.user_id,
    emojiAvatar: comment.emojiAvatar || "🚀",
    text: comment.text,
    createdAt: createdAtIso
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
      heartbreakCount: 0,
      commentCount: 0
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


// ====== GET COMMENTS ======
app.get("/api/feed/comments", async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (isRateLimited(`comments:${ip}`, 120)) {
      return res.status(429).json({ error: "Too many comment requests" });
    }

    const cardId = normalizeString(req.query.card_id || req.query.cardId, "", 100);
    if (!cardId) {
      return res.status(400).json({ error: "Missing card_id" });
    }

    const comments = await FeedComment.find({ card_id: cardId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({ items: comments.map(commentToClient) });
  } catch (err) {
    return next(err);
  }
});

// ====== POST FIXED COMMENT ======
app.post("/api/feed/comment", async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (isRateLimited(`comment:${ip}`, 30)) {
      return res.status(429).json({ error: "Too many comment attempts. Please slow down." });
    }

    const validation = validateCommentPayload(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const { userId, cardId, commentText } = validation.value;
    const card = await FeedCard.findOne({ id: cardId }).lean();
    if (!card) {
      return res.status(404).json({ error: "Card not found" });
    }

    const existing = await FeedComment.findOne({
      user_id: userId,
      card_id: cardId,
      text: commentText
    }).lean();

    if (existing) {
      const currentCard = await FeedCard.findOne({ id: cardId }).lean();
      return res.json({
        success: true,
        duplicate: true,
        comment: commentToClient(existing),
        item: currentCard ? cardToClient(currentCard, "") : null
      });
    }

    const emojiAvatar = await getEmoji(userId);
    const createdComment = await FeedComment.create({
      id: "comment_" + Date.now() + "_" + Math.floor(Math.random() * 100000),
      card_id: cardId,
      user_id: userId,
      emojiAvatar,
      text: commentText
    });

    const commentCount = await FeedComment.countDocuments({ card_id: cardId });
    const updatedCard = await FeedCard.findOneAndUpdate(
      { id: cardId },
      { commentCount },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      comment: commentToClient(createdComment.toObject()),
      item: updatedCard ? cardToClient(updatedCard, "") : null
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({ error: "Comment already posted" });
    }
    return next(err);
  }
});


// Small delay helper for natural AI reply timing
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====== DAILY ONLINE AI LIMIT ======
// Server handles real online AI only.
// Simple/offline chat should stay in main.dart to avoid double offline engines.
const dailyAiUsage = {};
const DAILY_ONLINE_AI_LIMIT = Number(process.env.DAILY_ONLINE_AI_LIMIT || 10);

function getCoachUserKey(req, body) {
  const explicitUserId = normalizeString(
    body.user_id || body.userId || body.feedUserId || body.deviceId,
    "",
    120
  );

  if (explicitUserId) return `user:${explicitUserId}`;

  return `ip:${getClientIp(req)}`;
}

function canUseOnlineAI(userKey) {
  const today = getTodayKey();

  if (!dailyAiUsage[userKey] || dailyAiUsage[userKey].day !== today) {
    dailyAiUsage[userKey] = { count: 0, day: today };
  }

  return dailyAiUsage[userKey].count < DAILY_ONLINE_AI_LIMIT;
}

function increaseOnlineAiUsage(userKey) {
  const today = getTodayKey();

  if (!dailyAiUsage[userKey] || dailyAiUsage[userKey].day !== today) {
    dailyAiUsage[userKey] = { count: 0, day: today };
  }

  dailyAiUsage[userKey].count += 1;
}

function cleanupOldDailyAiUsage() {
  const today = getTodayKey();

  for (const key of Object.keys(dailyAiUsage)) {
    if (dailyAiUsage[key].day !== today) {
      delete dailyAiUsage[key];
    }
  }
}

setInterval(cleanupOldDailyAiUsage, 60 * 60 * 1000).unref();

function emergencyCoachMessage() {
  return "I’m in light mode right now 😅 Try again later for deeper online coaching.";
}

function isRetryableAiError(err) {
  const rawMessage = err && err.message ? String(err.message) : "";
  const lowerMessage = rawMessage.toLowerCase();

  return (
    rawMessage.includes("429") ||
    rawMessage.includes("500") ||
    rawMessage.includes("502") ||
    rawMessage.includes("503") ||
    rawMessage.includes("504") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("quota") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("resource exhausted") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("network")
  );
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { raw: text };
    }

    if (!response.ok) {
      const errorMessage =
        data.error?.message ||
        data.error ||
        data.message ||
        data.raw ||
        `HTTP ${response.status}`;
      throw new Error(`${response.status}: ${errorMessage}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function askGemini(prompt, apiKey, keyIndex = 0) {
  if (!apiKey) {
    throw new Error("Gemini key is missing.");
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  console.log(`AI coach trying Gemini model: ${modelName} key #${keyIndex + 1}`);

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  return {
    text,
    provider: "Gemini",
    modelName,
    keyIndex,
  };
}

async function askOpenRouter(prompt, apiKey, keyIndex = 0) {
  if (!apiKey) {
    throw new Error("OpenRouter key is missing.");
  }

  const modelName =
    process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free";

  console.log(`AI coach trying OpenRouter model: ${modelName} key #${keyIndex + 1}`);

  const data = await fetchJsonWithTimeout(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_PUBLIC_URL || "https://trade-journal-backend-sz8r.onrender.com",
        "X-Title": "Trade Journal Pro",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.8,
        max_tokens: 700,
      }),
    }
  );

  return {
    text: data.choices?.[0]?.message?.content || "",
    provider: "OpenRouter",
    modelName,
    keyIndex,
  };
}

async function askGroq(prompt, apiKey, keyIndex = 0) {
  if (!apiKey) {
    throw new Error("Groq key is missing.");
  }

  const modelName = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  console.log(`AI coach trying Groq model: ${modelName} key #${keyIndex + 1}`);

  const data = await fetchJsonWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.8,
        max_tokens: 700,
      }),
    }
  );

  return {
    text: data.choices?.[0]?.message?.content || "",
    provider: "Groq",
    modelName,
    keyIndex,
  };
}

async function generateCoachAnswer(prompt) {
  const providers = [
    { name: "Gemini", keys: GEMINI_API_KEYS, run: askGemini },
    { name: "OpenRouter", keys: OPENROUTER_API_KEYS, run: askOpenRouter },
    { name: "Groq", keys: GROQ_API_KEYS, run: askGroq },
  ];

  let lastRetryableError = null;

  for (const provider of providers) {
    if (!provider.keys || provider.keys.length === 0) {
      console.warn(`⚠️ AI provider skipped (${provider.name}): no API keys configured.`);
      continue;
    }

    for (let keyIndex = 0; keyIndex < provider.keys.length; keyIndex += 1) {
      try {
        const result = await provider.run(prompt, provider.keys[keyIndex], keyIndex);
        const text = String(result.text || "").trim();

        if (text.length > 0) {
          console.log(`✅ AI coach success with ${provider.name} key #${keyIndex + 1}`);
          return {
            text,
            provider: result.provider || provider.name,
            modelName: result.modelName || "",
            keyIndex,
          };
        }

        throw new Error(`${provider.name} key #${keyIndex + 1} returned empty text.`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.warn(`❌ AI provider failed (${provider.name} key #${keyIndex + 1}): ${message}`);

        // Try the next key/provider for quota, rate limit, timeout, network, and empty-response issues.
        lastRetryableError = err;
        continue;
      }
    }
  }

  if (lastRetryableError) {
    throw lastRetryableError;
  }

  throw new Error("All AI providers failed or no API keys were configured.");
}

// ====== AI COACH (MULTI PROVIDER) ======
function safeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function buildCoachDataSummary(journal, importedTrades, chatHistory) {
  const safeJournal = safeArray(journal);
  const safeImported = safeArray(importedTrades);
  const safeHistory = safeArray(chatHistory);

  const recentJournal = safeJournal.slice(0, 8).map((trade) => {
    return {
      pair: trade.pair || trade.market || "",
      direction: trade.direction || "",
      result: trade.result || "",
      rr: trade.rr || "",
      risk: trade.risk || 0,
      setupTag: trade.setupTag || "",
      emotionTag: trade.emotionTag || "",
      mistakeTag: trade.mistakeTag || "",
      disciplineScore: trade.disciplineScore || 0,
      sessionLabel: trade.sessionLabel || "",
      notes: trade.notes || ""
    };
  });

  const recentImported = safeImported.slice(0, 12).map((trade) => {
    return {
      symbol: trade.symbol || "",
      direction: trade.direction || "",
      profit: trade.profit || 0,
      result: trade.result || "",
      sessionLabel: trade.sessionLabel || "",
      lot: trade.lot || 0
    };
  });

  const recentMessages = safeHistory.slice(-6).map((msg) => {
    return {
      sender: msg.sender || "",
      text: String(msg.text || "").slice(0, 300)
    };
  });

  const manualWins = safeJournal.filter((trade) => {
    const result = String(trade.result || "").toUpperCase();
    return result.includes("TP") || result === "WIN";
  }).length;

  const manualLosses = safeJournal.filter((trade) => {
    const result = String(trade.result || "").toUpperCase();
    return result.includes("SL") || result === "LOSS";
  }).length;

  const importedWins = safeImported.filter((trade) => {
    return Number(trade.profit || 0) > 0;
  }).length;

  const importedLosses = safeImported.filter((trade) => {
    return Number(trade.profit || 0) < 0;
  }).length;

  const disciplineScores = safeJournal
    .map((trade) => Number(trade.disciplineScore || 0))
    .filter((score) => Number.isFinite(score) && score > 0);

  let avgDiscipline = 0;
  if (disciplineScores.length > 0) {
    const disciplineTotal = disciplineScores.reduce((sum, score) => {
      return sum + score;
    }, 0);
    avgDiscipline = Math.round(disciplineTotal / disciplineScores.length);
  }

  return {
    counts: {
      manualTrades: safeJournal.length,
      importedTrades: safeImported.length,
      manualWins,
      manualLosses,
      importedWins,
      importedLosses,
      averageDiscipline: avgDiscipline
    },
    recentJournal,
    recentImported,
    recentMessages
  };
}

app.post("/api/coach/chat", async (req, res) => {
  try {
    const ip = getClientIp(req);

    if (isRateLimited(`coach:${ip}`, 40)) {
      await sleep(1200);
      return res.json({
        answer: "Easy there 😄 Too many messages too fast. Give me a moment."
      });
    }

    const body = req.body || {};
    const message = normalizeString(body.message, "", 1000);

    if (!message) {
      return res.status(400).json({ answer: "Missing message." });
    }

    const summary = buildCoachDataSummary(
      body.journal,
      body.importedTrades,
      body.chatHistory
    );

    const userKey = getCoachUserKey(req, body);

    // Daily online AI cap: after 10 online replies, stop calling paid/free APIs.
    // main.dart should handle simple/offline replies before calling this route.
    if (!canUseOnlineAI(userKey)) {
      await sleep(800);
      return res.json({
        answer: emergencyCoachMessage(),
        mode: "online_daily_limit_reached",
        remainingOnlineReplies: 0
      });
    }

    const prompt = `
You are Trade Journal Pro AI Coach.

You are not only a coach.
You are a smart, chill, human-like trading companion inside a trading journal app.

Core personality:
- Talk naturally like a real person.
- Be friendly, relaxed, emotionally aware, and lightly fun.
- Use light emojis when they fit, but do not spam emojis.
- Do not sound robotic, corporate, or templated.
- Do not force numbered formats unless it helps.
- Do not repeat "journal is empty" again and again.
- Keep most replies short and easy to read.
- Match the user's energy.

Mode switching:
- If the user is casual, chatting, joking, greeting, or asking simple things, reply casually.
- If the user asks about trading, losses, discipline, risk, entries, exits, sessions, mistakes, emotions, or performance, switch into coach mode.
- If there is no trade data, mention it gently only when needed, then continue the conversation normally.
- If the user asks for market news, explain you cannot fetch live news from here, but you can help them think through market prep or what to watch.
- Never promise profits or tell the user exactly what to buy/sell.

Coach mode:
- Be honest and useful, not harsh.
- Focus on behavior, process, discipline, risk, and journaling.
- Give one practical next move only when it is useful.
- Use the user's trade data if available.

User trading data:
${JSON.stringify(summary, null, 2)}

User message:
${message}

Reply as a real human. Make it natural, useful, and not spammy.
`;

    try {
      const generated = await generateCoachAnswer(prompt);
      const answerRaw = generated.text;
      const answer = normalizeString(answerRaw, "", 2500);

      if (answer) {
        increaseOnlineAiUsage(userKey);

        // Natural online AI timing: do not reply instantly.
        await sleep(5000);

        return res.json({
          answer,
          mode: "online_ai",
          provider: generated.provider || "",
          model: generated.modelName || "",
          remainingOnlineReplies:
            Math.max(DAILY_ONLINE_AI_LIMIT - (dailyAiUsage[userKey]?.count || 0), 0)
        });
      }

      await sleep(800);
      return res.json({
        answer: emergencyCoachMessage(),
        mode: "online_empty_ai"
      });
    } catch (aiErr) {
      console.error("AI coach online providers failed:", aiErr);

      // If every provider fails / quota is used, do not expose ugly errors.
      // Keep this as emergency backend fallback only; main.dart owns the richer offline engine.
      await sleep(800);
      return res.json({
        answer: emergencyCoachMessage(),
        mode: "online_ai_failed"
      });
    }
  } catch (err) {
    console.error("AI coach route error:", err);

    await sleep(1000);

    return res.json({
      answer: emergencyCoachMessage(),
      mode: "online_route_error"
    });
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
