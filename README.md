# Shorty - Minimal URL Shortener

Shorty is a free, open-source, minimal URL shortener built to run entirely on the Cloudflare edge network using Cloudflare Pages for the frontend and Cloudflare Workers for the backend API, with Cloudflare KV for data storage.

It provides a simple interface to shorten long URLs and includes features like click tracking, abuse reporting with automatic domain blocking based on report thresholds, and CAPTCHA protection using Cloudflare Turnstile.

## Features

*   **URL Shortening:** Generate short, unique links for any valid URL.
*   **Click Tracking:** Basic tracking of how many times a short link is clicked.
*   **Stats Check:** View the original URL, creation date, and click count for any short link.
*   **Abuse Reporting:** Users can report potentially malicious links.
*   **Automatic Blocking:** Domains reaching a configurable report threshold are automatically blocked from being shortened further.
*   **CAPTCHA Protection:** Uses Cloudflare Turnstile to protect link creation and abuse reporting endpoints from bots.
*   **Dark Mode:** Frontend includes a dark mode toggle.
*   **Deployable on Cloudflare:** Designed specifically for easy deployment on Cloudflare's free tiers.

## How it Works

1.  **Frontend (Cloudflare Pages):** A static `index.html` file served via Cloudflare Pages provides the user interface. It uses Tailwind CSS for styling and Alpine.js for interactivity. It communicates with the backend worker API.
2.  **Backend API (Cloudflare Worker):** A Cloudflare Worker (`worker.js`) handles API requests for creating links, retrieving stats, reporting abuse, and redirecting short links to their original destinations.
3.  **Data Storage (Cloudflare KV):** Cloudflare KV is used to store the mapping between short IDs and original URLs, as well as metadata like click counts, creation dates, blocked domains, and report counts.
4.  **Redirection:** Short links (e.g., `https://your-short.link/+abcde`) are directed to the Worker, which looks up the original URL in KV, increments the click count, and issues a permanent (301) redirect.

## Deployment Guide

Follow these steps to deploy your own instance of Shorty.

### Prerequisites

*   A Cloudflare account.
*   Node.js and npm installed locally.
*   Wrangler CLI installed (`npm install -g wrangler`).
*   Git installed locally.

### Setup Steps

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/lklynet/shorty.git # Replace with your repo URL if forked
    cd shorty
    ```

2.  **Configure Cloudflare:**
    *   **KV Namespace:** Create a KV namespace in your Cloudflare dashboard (Workers & Pages -> KV). Note the **Namespace ID**.
    *   **Turnstile Site:** Create a new Turnstile site in your Cloudflare dashboard (Turnstile). Choose the "Managed" challenge type. Note the **Site Key** and **Secret Key**.
    *   **Domains:** You'll need two domains/subdomains configured in Cloudflare DNS:
        *   One for the frontend Pages site (e.g., `shorty.yourdomain.com`).
        *   One for the short links themselves (e.g., `s.yourdomain.com`).
        *   (Optional but recommended) One for the API worker (e.g., `api.shorty.yourdomain.com`).

3.  **Configure Wrangler (`wrangler.toml`):**
    *   Open `wrangler.toml`.
    *   Change `name` to a unique name for your worker (e.g., `shorty-api-worker`).
    *   Update the `kv_namespaces` section:
        *   Replace the placeholder `id = "..."` value with the actual ID of the KV namespace you created.
    *   Ensure the top-level `routes` array is configured correctly. You will typically have one route for your API domain (e.g., `api.shorty.yourdomain.com/*`) and one for your short link domain (e.g., `s.yourdomain.com/+*` or similar, depending on your setup in Step 7). Example:
        ```toml
        routes = [
          { pattern = "api.shorty.yourdomain.com/*", zone_name = "yourdomain.com" },
          { pattern = "s.yourdomain.com/+*", zone_name = "yourdomain.com" }
        ]
        ```
        *(Replace `api.shorty.yourdomain.com`, `s.yourdomain.com`, and `yourdomain.com` with your actual domains/zone names)*

4.  **Configure Environment Variables & Secrets:**
    *   Create a `.env` file (or use the provided one) to keep track of your keys and variables. **Do not commit this file with actual secrets.**
    *   **Worker Secrets:** Use Wrangler to set the Turnstile secret key:
        ```bash
        wrangler secret put TURNSTILE_SECRET_KEY
        # Paste your Turnstile Secret Key when prompted
        ```
    *   **Worker Environment Variables:** Set `FRONTEND_DOMAIN`, `SHORT_DOMAIN`, and optionally `REPORT_BLOCK_THRESHOLD` either in `wrangler.toml` under `[vars]` or directly in the deployed Worker's settings via the Cloudflare dashboard.
    *   **Pages Environment Variables:** Create a new Cloudflare Pages project linked to your repository. In the project settings (Settings -> Environment variables -> Production), add the **required** public variables: `PUBLIC_API_WORKER_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, and `PUBLIC_SHORT_DOMAIN`. Optionally add `PUBLIC_UMAMI_SCRIPT_URL` and `PUBLIC_UMAMI_WEBSITE_ID` if using Umami analytics.

5.  **Deploy the Worker:**
    ```bash
    wrangler deploy
    ```
    *(Note: The first deploy might use `wrangler publish` depending on your Wrangler version and configuration)*

6.  **Deploy the Frontend (Pages):**
    *   Connect your Git repository to Cloudflare Pages.
    *   Configure the build settings:
        *   **Framework preset:** `None`
        *   **Build command:** `npm run build`
        *   **Build output directory:** `/`
        *   **Root directory:** `/` (if `package.json` is in the root)
    *   Add the **Pages Environment Variables** as described in step 4 (under Settings -> Environment variables -> Production). These are crucial for the build script.
    *   Deploy the site.
    *   Assign your custom frontend domain (e.g., `shorty.yourdomain.com`) to the Pages project.

7.  **Configure Short Domain Redirection:**
    *   Go to the DNS settings for your **short link domain** (e.g., `s.yourdomain.com`) in the Cloudflare dashboard.
    *   Add a CNAME record pointing `@` (root) or `*` (wildcard) to your **API worker's domain** (e.g., `api.shorty.yourdomain.com`). Ensure the proxy status is **enabled** (orange cloud).
    *   *(Alternatively, you could point the short domain directly to the worker using routes in `wrangler.toml`, but separating the API domain is often cleaner).*
    *   **Crucially**, you need to ensure requests like `https://s.yourdomain.com/+abcde` are handled by the worker. If you pointed the CNAME to your API domain, the route in `wrangler.toml` (`api.shorty.yourdomain.com/*`) should handle this. If you routed the short domain directly in `wrangler.toml`, ensure that route captures these paths.

## Configuration

Configuration is managed through environment variables and secrets set in Cloudflare. Refer to the `.env` file for a detailed list and where each variable should be set (Worker Secrets, Worker Variables, or Pages Variables).

**Key Variables:**

*   `TURNSTILE_SECRET_KEY` (Worker Secret): Your Cloudflare Turnstile secret key.
*   `FRONTEND_DOMAIN` (Worker Variable): Full URL of your Pages frontend (for CORS).
*   `SHORT_DOMAIN` (Worker Variable): Base URL for generated short links (e.g., `https://s.yourdomain.com`).
*   `PUBLIC_API_WORKER_URL` (Pages Variable): Full URL of your deployed Worker API.
*   `PUBLIC_TURNSTILE_SITE_KEY` (Pages Variable): Your public Cloudflare Turnstile site key.
*   `PUBLIC_SHORT_DOMAIN` (Pages Variable): Same as `SHORT_DOMAIN`, used for UI placeholders.

## API Endpoints

*   `POST /api/create`: Creates a short link.
    *   Body: `{ "longUrl": "...", "cf-turnstile-response": "..." }`
    *   Response: `{ "shortUrl": "...", "originalUrl": "..." }`
*   `GET /api/stats/{shortId}`: Gets stats for a short link.
    *   Response: `{ "originalUrl": "...", "createdAt": "...", "clicks": ... }`
*   `POST /api/report`: Reports a URL as abusive.
    *   Body: `{ "reportedUrl": "...", "cf-turnstile-response": "..." }`
    *   Response: `{ "message": "..." }`

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

## License

This project is licensed under the MIT License. See the LICENSE file for details (if one exists - add one if desired).
