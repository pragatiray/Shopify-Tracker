# Shopify Engagement Tracker

An AI-powered session analysis tool for Shopify stores. A lightweight frontend snippet collects anonymous behavioural events (page views, clicks, time on page) and periodically sends them to a Node.js backend. The backend uses **Google Gemini** to decide whether to trigger a non-intrusive modal prompt to help convert the visitor.

---

## Architecture

```
Shopify Theme (theme.liquid)
  └── engagement-tracker.js   ← frontend snippet (zero dependencies)
          │  POST /analyze (JSON)
          ▼
  index.js (Express API)
          │  generateContent()
          ▼
  Google Gemini (gemini-2.5-flash)
          │  { trigger: bool, message: string }
          ▼
  engagement-tracker.js → showModal()
```

---

## Files

| File | Description |
|---|---|
| `engagement-tracker.js` | Inline `<script>` snippet embedded in `theme.liquid`. Tracks events, flushes to the API, and renders the modal. |
| `index.js` | Express.js backend. Validates the session payload, calls Gemini, and returns a trigger decision. |

---

## How It Works

### Frontend (`engagement-tracker.js`)

- Runs as an IIFE inside the browser — no build step, no dependencies.
- Assigns each browser tab a `sessionId` (stored in `sessionStorage`).
- Tracks three event types and stores them in `sessionStorage`:

| Event | Trigger |
|---|---|
| `page_view` | On script load (every page navigation) |
| `click` | Clicks on Add-to-Cart buttons and cart links |
| `time_on_page` | Recorded on tab hide / page unload |

- Flushes events to `/analyze` every **30 seconds** via `fetch` + `keepalive`.
- On Add-to-Cart clicks, flushes **immediately**.
- On tab close / navigation, flushes via **`navigator.sendBeacon`** for reliability.
- Shows the modal **once per session** when the API returns `{ "trigger": true }`.
- Never captures PII (passwords, card numbers, email fields are all guarded).

### Backend (`index.js`)

1. Validates `sessionId` and `events` array in the request body.
2. Silently returns `{ trigger: false }` if:
   - Total time on site is under **10 seconds**.
   - The user is currently on a **checkout page**.
3. Builds a structured session summary and sends it to Gemini with a CRO-specialist system prompt.
4. Parses the Gemini JSON response and enforces a **15-word cap** on the message.
5. Returns `{ trigger: boolean, message?: string }`.

---

## API

### `GET /health`

Returns server status and uptime.

```json
{ "status": "ok", "uptime": 123.4 }
```

### `POST /analyze`

**Request body:**

```json
{
  "sessionId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "events": [
    {
      "type": "page_view",
      "timestamp": "2026-04-07T10:00:00.000Z",
      "sessionId": "...",
      "url": "https://yourstore.myshopify.com/products/example",
      "payload": {
        "pageType": "product",
        "title": "Example Product",
        "referrer": "https://google.com"
      }
    },
    {
      "type": "time_on_page",
      "timestamp": "...",
      "url": "...",
      "payload": { "seconds": 75 }
    }
  ]
}
```

**Response:**

```json
{ "trigger": true, "message": "Still thinking it over? We can help you decide." }
```

or

```json
{ "trigger": false }
```

---

## Setup

### 1. Backend

**Requirements:** Node.js 18+

```bash
npm install
```

Create a `.env` file:

```env
GEMINI_API_KEY=your_gemini_api_key_here

# Optional
PORT=3000
ALLOWED_ORIGINS=https://yourstore.myshopify.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
```

Start the server:

```bash
node index.js
```

---

### 3. Expose the Backend with ngrok

Shopify runs in the browser over HTTPS, so your local server must be reachable via a public HTTPS URL. [ngrok](https://ngrok.com) provides this tunnel.

**Install ngrok:**

```bash
# macOS/Linux (Homebrew)
brew install ngrok

# Windows (Chocolatey)
choco install ngrok

# Or download directly from https://ngrok.com/download
```

**Authenticate** (one-time, free account required):

```bash
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

**Start the tunnel** pointing at your backend port:

```bash
ngrok http 3000
```

ngrok will output something like:

```
Forwarding  https://stephane-unapprehended-osteologically.ngrok-free.dev -> http://localhost:3000
```

Copy the `https://` URL and use it in two places:

1. **`engagement-tracker.js`** — update `API_ENDPOINT`:

```js
var API_ENDPOINT = 'https://YOUR-SUBDOMAIN.ngrok-free.dev/analyze';
```

2. **`.env`** — update `ALLOWED_ORIGINS`:

```env
ALLOWED_ORIGINS=https://yourstore.myshopify.com
```

> **Note:** The free ngrok plan generates a new URL each time you restart it. For a stable URL across restarts use a [fixed domain](https://ngrok.com/docs/ngrok-agent/config/#tunnels) (`ngrok http --domain=your-fixed-domain.ngrok-free.dev 3000`) or upgrade to a paid plan.

---

### 4. Frontend

Copy the contents of `engagement-tracker.js` into a `<script>` tag in your Shopify theme's `theme.liquid`, just before the closing `</body>` tag.

Update the `API_ENDPOINT` constant at the top of the file to your ngrok (or production) URL:

```js
var API_ENDPOINT = 'https://YOUR-SUBDOMAIN.ngrok-free.dev/analyze';
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key |
| `PORT` | No | `3000` | Port the Express server listens on |
| `ALLOWED_ORIGINS` | No | `*` (dev) | Comma-separated list of allowed CORS origins |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit rolling window in milliseconds |
| `RATE_LIMIT_MAX` | No | `30` | Max requests per window per IP |

> **Important:** Set `ALLOWED_ORIGINS` to your Shopify store URL in production (e.g. `https://yourstore.myshopify.com`). Leaving it unset allows all origins.

---

## Gemini Trigger Rules

The AI will **not** trigger a modal if:

- The user has spent fewer than 60 seconds on the site (enforced in the prompt; backend pre-checks 10 seconds).
- The user is on a checkout page.
- No meaningful engagement has occurred.

It **will** consider triggering if:

- The user has viewed the same product 3+ times.
- The user added to cart but has not checked out.
- The user shows high time-on-site with low conversion signals.

The modal message is capped at **15 words**.

---

## Security

- No PII is captured or sent to Gemini — only structured metadata (URLs, page types, click selectors).
- All secrets are loaded from environment variables; none are hardcoded.
- `helmet` sets secure HTTP response headers.
- Rate limiting is applied per IP to prevent abuse.
- CORS is restricted to declared origins in production.
- The Gemini API call has a **9-second timeout**.

---

## Known Limitations

- The event queue is cleared after each flush. The backend evaluates each 30-second window in isolation rather than the full session — see [open bug](#) for the fix roadmap.
- `sendBeacon` responses cannot be read by JavaScript, so a modal can never be triggered from a tab-close flush.
- Shopify's Content Security Policy may need updating to allow `connect-src` to your backend domain.