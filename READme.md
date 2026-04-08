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


- Zero-Dependency IIFE: Runs as a self-contained script inside the browser—no build step or external libraries required.

- Session Management: Assigns each browser tab a unique sessionId (stored in sessionStorage) to maintain a consistent user "story."

- Stateful Event Queue: Tracks three event types and stores them in a cumulative queue in sessionStorage:

- page_view: Fired on script load (at every new page navigation).

- click: Captured via delegated listeners, specifically targeting Add-to-Cart buttons and cart links.

- time_on_page: Calculated and recorded periodically (every 30s) and upon page unload to track total engagement duration.

Intelligent Flushing:

- Periodic Sync: Flushes the full event history to /analyze every 30 seconds via fetch + keepalive.

- High-Intent Trigger: Flushes immediately upon Add-to-Cart clicks to get real-time AI analysis.

- Reliable Exit: On tab close or navigation, flushes via navigator.sendBeacon (or keepalive) to ensure the final engagement data reaches the server.

- AI-Driven UI: Injects and shows the modal exactly once per session only when the API returns { "trigger": true }.

- PII Guard: Actively ignores sensitive inputs. It uses an element-traversal check to ensure passwords, card numbers, and email fields are never captured or sent to the LLM.

### Backend (`index.js`)

1.Validates sessionId (string) and events (non-empty array) in the request body.
2.Silently returns { trigger: false } if:
- Total time on site is under 60 seconds.
- The user is currently on a checkout page.
3.Builds a structured session summary (page views, clicks, cart actions, total time) and sends it to Gemini with a CRO-specialist system prompt.
4. Enhances the payload with a derived signal:
repeated_product_views (true if a product is viewed 3+ times).

5. Calls Gemini with a timeout (~9 seconds) and expects a strict JSON response:
{ "trigger": boolean, "message": "string" }
6.Safely parses the response:
- Handles malformed/non-JSON outputs
- Falls back to { trigger: false } on failure
7.Enforces a 15-word cap on the returned message.
8.Returns:
{ "trigger": boolean, "message"?: "string" }

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
GEMINI_MODEL= your_gemini_model_here

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
| `GEMINI_MODEL` | Yes | — | Google Gemini model |
| `PORT` | No | `3000` | Port the Express server listens on |
| `ALLOWED_ORIGINS` | No | `*` (dev) | Comma-separated list of allowed CORS origins |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit rolling window in milliseconds |
| `RATE_LIMIT_MAX` | No | `30` | Max requests per window per IP |

> **Important:** Set `ALLOWED_ORIGINS` to your Shopify store URL in production (e.g. `https://yourstore.myshopify.com`). Leaving it unset allows all origins.

---

## Gemini Trigger Rules

The AI will **not** trigger a modal if:

- The user has spent fewer than 60 seconds on the site (enforced in the prompt; backend pre-checks 60 seconds).
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

- Cumulative Payload Scaling: The event queue is preserved until a trigger occurs to provide the AI with full session context. For exceptionally long sessions, this results in larger JSON payloads which may increase latency during the flush cycle.

- sendBeacon / keepalive Response Blindness: Background requests sent during page unloads (like visibilitychange) cannot have their responses read by JavaScript. Therefore, a modal can never be triggered from an exit-intent flush.

- Shopify Content Security Policy (CSP): Tracking may be blocked by Shopify's security headers. Merchants must whitelist the backend domain in the connect-src directive of their CSP to allow the tracker to communicate with the API.

- Session-Based Trigger Lock: To optimize for user experience and API quota, the system enforces a "one-modal-per-session" rule. Once a trigger is successful, all further tracking and AI analysis are suspended for that session.
- <img width="1470" height="956" <img width="1470" height="956" alt="Screenshot 2026-04-08 at 14 51 01" src="https://github.com/user-attachments/assets/64d9b02e-56eb-4859-896d-afb3316c4415" />

