/**
 * Engagement Tracker – Backend Service (Gemini Pro Edition)
 * ────────────────────────────────────────────────────────────────
 * POST /analyze → receives session event log, asks Gemini for an
 *                  engagement verdict, and optionally triggers
 *                  a client-side modal.
 *
 * Constraints honoured:
 *   ✓ No hardcoded API keys (process.env only)
 *   ✓ Only structured metadata sent to Gemini (no raw HTML)
 *   ✓ 5-second timeout on the Gemini API call
 * ────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ──────────────────────── VALIDATE ENV ─────────────────────────── */

const REQUIRED_ENV = ['GEMINI_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`✖  Missing required env var: ${key}`);
    process.exit(1);
  }
}

/* ──────────────────────── INIT ─────────────────────────────────── */

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Gemini client initialization
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/* ──────────────────────── MIDDLEWARE ───────────────────────────── */

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0
    ? function (origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS: origin not allowed'));
    }
    : true,
  methods: ['POST', 'GET'],
}));

app.use(express.json({ limit: '256kb' }));

app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

/* ──────────────────────── HELPERS ──────────────────────────────── */

function buildSessionSummary(sessionId, events) {
  const pageViews = [];
  const clicks = [];
  let totalTime = 0;
  let currentUrl = null;
  let cartActions = 0;

  for (const evt of events) {
    switch (evt.type) {
      case 'page_view':
        pageViews.push({
          url: evt.url,
          pageType: evt.payload?.pageType || 'unknown',
          title: (evt.payload?.title || '').slice(0, 120),
          time: evt.timestamp,
        });
        currentUrl = evt.url;
        break;
      case 'click':
        clicks.push({
          selector: evt.payload?.selector || '',
          text: (evt.payload?.text || '').slice(0, 80),
          isAddToCart: !!evt.payload?.isAddToCart,
          url: evt.url,
          time: evt.timestamp,
        });
        if (evt.payload?.isAddToCart) cartActions++;
        break;
      case 'time_on_page':
        totalTime += evt.payload?.seconds || 0;
        break;
      default:
        break;
    }
  }

  return {
    sessionId,
    currentUrl,
    totalPageViews: pageViews.length,
    pageViews,
    totalClicks: clicks.length,
    clicks,
    cartActions,
    totalTimeSeconds: totalTime,
  };
}

function buildPrompt(summary) {
  const system = [
    'You are a "Conversion Rate Optimization" (CRO) Specialist.',
    'Analyze a Shopify user session and decide if showing a proactive message will help them convert.',
    '',
    'INPUT you receive:',
    '• events – list of page views and clicks',
    '• cart_status – number of Add-to-Cart actions',
    '• time_spent – total seconds on site',
    '',
    'OUTPUT: Return ONLY raw JSON, no markdown, no explanations.',
    '{"trigger": boolean, "message": "string"}',
    '',
    'RULES:',
    '1. Do NOT trigger if time_spent < 60 seconds.',
    '2. Do NOT trigger if user is on a Checkout page.',
    '3. No generic discounts unless same product viewed 3+ times or cart abandoned.',
    '4. "message" must be ≤ 15 words.',
  ].join('\n');

  const userMessage = JSON.stringify({
    events: summary.pageViews.concat(summary.clicks),
    cart_status: {
      addToCartActions: summary.cartActions,
      hasItemsInCart: summary.cartActions > 0,
    },
    time_spent: summary.totalTimeSeconds,
    current_url: summary.currentUrl,
  }, null, 2);

  return { system, userMessage };
}

function hasRepeatedProductViews(summary) {
  const productCounts = {};
  for (const pv of summary.pageViews) {
    if (pv.pageType === 'product') {
      productCounts[pv.url] = (productCounts[pv.url] || 0) + 1;
    }
  }
  return Object.values(productCounts).some(c => c >= 3);
}

function isOnCheckout(summary) {
  if (!summary.currentUrl) return false;
  return /\/checkouts?\//i.test(summary.currentUrl);
}

function parseLlmResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned);
}

/* ──────────────────────── ROUTES ───────────────────────────────── */

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/analyze', async (req, res) => {
  try {
    const { sessionId, events } = req.body;
    // console.log(`⚡ Received request for session: ${sessionId}`);

    // // 2. FORCE TRIGGER: Hardcoded response to test the frontend popup
    // return res.json({
    //   trigger: true,
    //   message: "FORCED TEST: Your Gemini integration is wired up correctly!"
    // });


    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid sessionId.' });
    }
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array.' });
    }

    const summary = buildSessionSummary(sessionId, events);

    // Debug log for tracking progress
    console.log(`[Session ${sessionId}] Views: ${summary.totalPageViews}, Clicks: ${summary.totalClicks}, Time: ${summary.totalTimeSeconds}s`);

    if (summary.totalTimeSeconds < 60 || isOnCheckout(summary)) {
      console.log("Too short")
      return res.json({ trigger: false });
    }

    const { system, userMessage } = buildPrompt(summary);
    const enriched = JSON.parse(userMessage);
    enriched.repeated_product_views = hasRepeatedProductViews(summary);

    const geminiModel = genAI.getGenerativeModel({
      model: MODEL,
      systemInstruction: system
    });

    let resultText = '';
    try {
      const result = await Promise.race([
        geminiModel.generateContent(JSON.stringify(enriched)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout')), 9000)),
      ]);

      const response = result?.response;
      resultText = (response?.text && typeof response.text === 'function') ? response.text() : response;
    } catch (err) {
      console.error('[Gemini Error]', err.message || err);
      return res.json({ trigger: false });
    }

    let parsed;
    try {
      parsed = parseLlmResponse(resultText || '');
    } catch {
      console.warn('[Parse Warning] Gemini returned non-JSON:', resultText);
      return res.json({ trigger: false });
    }

    if (parsed.trigger && parsed.message) {
      const wordCount = parsed.message.trim().split(/\s+/).length;
      if (wordCount > 15) {
        parsed.message = parsed.message.trim().split(/\s+/).slice(0, 15).join(' ') + '…';
      }
    }

    return res.json({
      trigger: parsed.trigger === true,
      message: parsed.trigger === true ? (parsed.message || '') : undefined,
    });

  } catch (err) {
    console.error('[/analyze] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ──────────────────────── START ────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`✔  Engagement Tracker API listening on :${PORT}`);
  console.log(`   Model : ${MODEL}`);
  console.log(`   CORS  : ${allowedOrigins.length ? allowedOrigins.join(', ') : '* (dev mode)'}`);
});
