// Define the KV namespace binding name. This MUST match the binding name in your wrangler.toml
// We'll use 'SHORTY_LINKS' as the namespace name.
// We'll also store metadata (like click count) in a separate namespace or by appending to the key.
// Let's use key suffixes for simplicity: `id` stores the URL, `id_meta` stores metadata.
// const LINKS_KV = SHORTY_LINKS; // This global variable is injected by the Cloudflare environment

// Simple random string generator for short IDs
function generateShortId(length = 6) {
  const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// Helper to return JSON responses
function jsonResponse(data, status = 200, headers = {}) {
  headers['Content-Type'] = 'application/json';
  headers['Access-Control-Allow-Origin'] = 'https://shorty.lkly.net'; // Restrict to frontend domain
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  return new Response(JSON.stringify(data), { status, headers });
}

// Helper to return error responses
function errorResponse(message, status = 400, headers = {}) { // Add headers parameter
  // Ensure base CORS headers are included if custom ones are provided
  const finalHeaders = {
      'Access-Control-Allow-Origin': 'https://shorty.lkly.net', // Restrict to frontend domain
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...headers // Merge provided headers
  };
  return jsonResponse({ error: message }, status, finalHeaders); // Pass headers to jsonResponse
}

// Function to check URL against Google Safe Browsing (Web Risk API)
async function isUrlMalicious(urlToCheck, apiKey) {
    if (!apiKey) {
        console.error("Google Safe Browsing API Key not configured in worker environment.");
        // Fail closed (block link creation) if key is missing
        throw new Error("Safe Browsing configuration error.");
    }

    // Construct the API URL. We check for common threat types.
    const webRiskUrl = `https://webrisk.googleapis.com/v1/uris:lookup?key=${apiKey}&uri=${encodeURIComponent(urlToCheck)}&threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE`;

    try {
        const response = await fetch(webRiskUrl);
        if (!response.ok) {
            // Log API error but block creation (fail closed)
            console.error(`Google Web Risk API error: ${response.status} ${response.statusText}`, await response.text());
            throw new Error(`Safe Browsing check failed (API status: ${response.status}).`);
        }

        const data = await response.json();

        // If 'threat' key exists in the response, the URL is considered malicious
        if (data.threat) {
            console.log(`Blocked malicious URL: ${urlToCheck}, Threat types: ${data.threat.threatTypes.join(', ')}`);
            return true; // URL is malicious
        }

        return false; // URL is safe

    } catch (error) {
        console.error("Error during Google Web Risk API call:", error);
        // Fail closed - block if the check fails for any reason (e.g., network error)
        throw new Error("Safe Browsing check failed.");
    }
}

export default {
  async fetch(request, env, ctx) {
    // env.SHORTY_LINKS will be our KV namespace
    const LINKS_KV = env.SHORTY_LINKS;
    if (!LINKS_KV) {
        return errorResponse("KV Namespace 'SHORTY_LINKS' not bound.", 500);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // Note: Hostname check is removed as wrangler.toml now routes only api.shorty.lkly.net/* to this worker.

    // Handle CORS preflight requests for API endpoints
    if (method === 'OPTIONS' && (path.startsWith('/api/'))) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://shorty.lkly.net', // Restrict to frontend domain
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400', // Cache preflight response for 1 day
        },
      });
    }

    // API endpoint for creating short links
    if (path === '/api/create' && method === 'POST') {
      // Allow CORS for this endpoint specifically if OPTIONS didn't catch it broadly
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'https://shorty.lkly.net', // Restrict to frontend domain
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      try {
        // Extract Turnstile token and longUrl from the request body
        const requestBody = await request.json();
        const longUrl = requestBody.longUrl;
        const token = requestBody['cf-turnstile-response']; // Standard field name
        const ip = request.headers.get('CF-Connecting-IP'); // Get the client's IP address

        // 1. Validate Turnstile Token
        if (!token) {
          return errorResponse('Missing CAPTCHA token.', 400, corsHeaders);
        }

        // Secret key is stored in env via `wrangler secret put TURNSTILE_SECRET_KEY`
        const SECRET_KEY = env.TURNSTILE_SECRET_KEY;
        if (!SECRET_KEY) {
            console.error("TURNSTILE_SECRET_KEY not set in worker environment.");
            return errorResponse('CAPTCHA configuration error.', 500, corsHeaders);
        }

        let formData = new FormData();
        formData.append('secret', SECRET_KEY);
        formData.append('response', token);
        if (ip) {
            formData.append('remoteip', ip); // Include client IP for better validation
        }

        const turnstileResult = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
        });

        const outcome = await turnstileResult.json();
        if (!outcome.success) {
            console.log('Turnstile verification failed:', outcome);
            return errorResponse(`CAPTCHA verification failed. [${outcome['error-codes']?.join(', ') || 'Unknown reason'}]`, 403, corsHeaders);
        }
        // --- End Turnstile Validation ---

        // 2. Check if URL is malicious (if Turnstile passed)
        const GOOGLE_API_KEY = env.GOOGLE_SAFE_BROWSING_API_KEY;
        // Note: The isUrlMalicious function throws errors if key is missing or API fails,
        // which will be caught by the main try/catch block below.
        if (await isUrlMalicious(longUrl, GOOGLE_API_KEY)) {
            return errorResponse('Provided URL is flagged as unsafe and cannot be shortened.', 400, corsHeaders);
        }
        // --- End Safe Browsing Check ---

        // 3. Proceed with link creation if Turnstile and Safe Browsing passed
        if (!longUrl) {
          // Use the main corsHeaders for the error response too
          return errorResponse('Missing longUrl parameter', 400, corsHeaders); // Should be caught earlier, but keep for safety
        }
        // Basic URL validation (consider more robust validation)
        try {
            new URL(longUrl);
        } catch (_) {
            // Use the main corsHeaders for the error response too
            return errorResponse('Invalid URL format provided.', 400, corsHeaders);
        }
        let shortId;
        let attempts = 0;
        const maxAttempts = 5; // Prevent infinite loops in case of unlikely collisions

        // Generate a unique short ID
        do {
          shortId = generateShortId();
          attempts++;
          if (attempts > maxAttempts) {
            // Use the main corsHeaders for the error response too
            return errorResponse('Failed to generate a unique short ID.', 500, corsHeaders);
          }
          // Check if ID already exists in KV
        } while (await LINKS_KV.get(shortId) !== null);

        const metadata = {
          originalUrl: longUrl,
          createdAt: new Date().toISOString(),
          clicks: 0,
        };

        // Store the long URL using the short ID as the key
        // Store metadata separately or alongside. Let's store metadata under `shortId_meta`
        await LINKS_KV.put(shortId, longUrl);
        await LINKS_KV.put(`${shortId}_meta`, JSON.stringify(metadata));

        const shortUrlBase = 'https://lkly.net'; // Use the final short domain
        const shortUrl = `${shortUrlBase}/+${shortId}`; // Add the '+' before the shortId
        // Return response with CORS headers
        return jsonResponse({ shortUrl, originalUrl: longUrl }, 200, corsHeaders);

      } catch (e) {
        console.error("Error creating link:", e);
        // Return error response with CORS headers
        return errorResponse(e.message || 'Failed to create short link.', 500, corsHeaders);
      }
    }

    // API endpoint for checking stats
    else if (path.startsWith('/api/stats/') && method === 'GET') {
        // Allow CORS for this endpoint
        const corsHeaders = {
          'Access-Control-Allow-Origin': 'https://shorty.lkly.net', // Restrict to frontend domain
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        };
        // Handle preflight request specifically for /api/stats/* if needed
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        let shortId = path.substring('/api/stats/'.length);
        // Remove leading '+' if present in the path from the frontend request
        if (shortId.startsWith('+')) {
            shortId = shortId.substring(1);
        }

         if (!shortId) {
            return errorResponse('Missing short ID in path.', 400, corsHeaders);
        }

        try {
            const metadataJson = await LINKS_KV.get(`${shortId}_meta`);
            if (!metadataJson) {
                return errorResponse('Short URL not found.', 404, corsHeaders);
            }
            const metadata = JSON.parse(metadataJson);
            return jsonResponse(metadata, 200, corsHeaders);
        } catch (e) {
            console.error("Error fetching stats:", e);
            return errorResponse(e.message || 'Failed to fetch stats.', 500, corsHeaders);
        }
    }

    // Handle Redirects (Any path that isn't /api/*)
    // This logic runs because the Page Rule forwards lkly.net/+<id> to api.shorty.lkly.net/+<id>
    else if (!path.startsWith('/api/')) {
      // Check if the path starts with /+ and extract the ID after it
      let shortId = null;
      if (path.startsWith('/+')) {
          shortId = path.substring(2); // Remove leading '/+'
      }

      if (!shortId) {
          // If someone accesses api.shorty.lkly.net/ or api.shorty.lkly.net/something_else
          // show a message or handle as appropriate.
          return new Response('Shorty API Endpoint. Use shorty.lkly.net for the frontend.', { status: 200 });
      }

      try {
        const longUrl = await LINKS_KV.get(shortId);

        if (longUrl) {
          // Update click count asynchronously (don't block the redirect)
          ctx.waitUntil((async () => {
              try {
                  const metadataJson = await LINKS_KV.get(`${shortId}_meta`);
                  if (metadataJson) {
                      const metadata = JSON.parse(metadataJson);
                      metadata.clicks = (metadata.clicks || 0) + 1;
                      await LINKS_KV.put(`${shortId}_meta`, JSON.stringify(metadata));
                  } else {
                      // Handle case where meta might be missing (e.g., older links)
                      // Optionally create initial metadata here
                      console.warn(`Metadata missing for shortId: ${shortId}`);
                  }
              } catch (e) {
                  console.error(`Failed to update click count for ${shortId}:`, e);
              }
          })());

          // Perform the redirect
          return Response.redirect(longUrl, 301); // Use 301 for permanent redirect
        } else {
          // If short ID not found, maybe redirect to homepage or show a 404 page
          // For now, let's return a simple 404 text response
           // Redirect logic remains the same
           return new Response('Short URL not found.', { status: 404 });
        }
      } catch (e) {
         console.error("Error during redirect:", e);
         return new Response('An error occurred during redirect.', { status: 500 });
      }
    }

    // Fallback for any other requests to api.shorty.lkly.net (e.g. /api/unknown)
    else {
        return errorResponse('API endpoint not found.', 404);
    }
  },
};
