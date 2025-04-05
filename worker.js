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

        // 2. Check if domain is manually blocked in KV
        let domainToCheck = null;
        try {
            const urlObject = new URL(longUrl);
            domainToCheck = urlObject.hostname;
             // Normalize domain (e.g., remove www.)
             if (domainToCheck.startsWith('www.')) {
                domainToCheck = domainToCheck.substring(4);
            }
        } catch (e) {
             // Invalid URL format check happens later, but catch potential errors here too
             console.log("Could not parse domain for blocklist check:", longUrl, e.message);
             // Proceed, let the later validation handle the invalid URL format
        }

        if (domainToCheck) {
            const blockKey = `BLOCKED:${domainToCheck}`;
            const isBlocked = await LINKS_KV.get(blockKey);
            if (isBlocked !== null) { // Check if the key exists (value doesn't matter, just existence)
                console.log(`Blocked attempt to shorten URL from blocked domain: ${domainToCheck}`);
                return errorResponse('This domain has been blocked and cannot be shortened.', 403, corsHeaders);
            }
        }
        // --- End Blocklist Check ---

        // 3. Proceed with link creation if Turnstile passed and domain not blocked
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

    // API endpoint for reporting abuse
    else if (path === '/api/report' && method === 'POST') {
        const corsHeaders = { // Define CORS headers for this endpoint
            'Access-Control-Allow-Origin': 'https://shorty.lkly.net',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };
        // Handle preflight requests specifically for /api/report
        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        try {
            const requestBody = await request.json();
            const reportedUrl = requestBody.reportedUrl;
            const token = requestBody['cf-turnstile-response'];
            const ip = request.headers.get('CF-Connecting-IP');

            // 1. Validate Turnstile Token
            if (!token) {
                return errorResponse('Missing CAPTCHA token.', 400, corsHeaders);
            }
            const SECRET_KEY = env.TURNSTILE_SECRET_KEY;
            if (!SECRET_KEY) {
                console.error("TURNSTILE_SECRET_KEY not set in worker environment.");
                return errorResponse('CAPTCHA configuration error.', 500, corsHeaders);
            }
            let formData = new FormData();
            formData.append('secret', SECRET_KEY);
            formData.append('response', token);
            if (ip) formData.append('remoteip', ip);

            const turnstileResult = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: formData });
            const outcome = await turnstileResult.json();
            if (!outcome.success) {
                console.log('Report Turnstile verification failed:', outcome);
                return errorResponse(`CAPTCHA verification failed. [${outcome['error-codes']?.join(', ') || 'Unknown reason'}]`, 403, corsHeaders);
            }
            // --- End Turnstile Validation ---

            // 2. Extract Domain and Increment Report Count
            if (!reportedUrl) {
                return errorResponse('Missing reportedUrl parameter.', 400, corsHeaders);
            }

            let targetUrl = reportedUrl;
            let domain = null;

            try {
                // Check if it's a shorty URL first (e.g., https://lkly.net/+abc)
                const shortUrlPattern = /^https:\/\/lkly\.net\/\+(.+)$/;
                const shortMatch = reportedUrl.match(shortUrlPattern);

                if (shortMatch && shortMatch[1]) {
                    const shortId = shortMatch[1];
                    const originalUrl = await LINKS_KV.get(shortId);
                    if (originalUrl) {
                        targetUrl = originalUrl; // Now we have the destination URL
                    } else {
                        // Report is for a non-existent short link, maybe ignore or log differently?
                        // Let's just return success for now, as the link doesn't exist anyway.
                         return jsonResponse({ message: 'Report noted (short link not found).' }, 200, corsHeaders);
                    }
                }

                // Extract domain from the target URL (either original input or looked up)
                const urlObject = new URL(targetUrl);
                domain = urlObject.hostname;
                // Normalize domain (e.g., remove www.) - optional but good practice
                if (domain.startsWith('www.')) {
                    domain = domain.substring(4);
                }

            } catch (e) {
                // Invalid URL submitted for report
                console.log("Invalid URL submitted for report:", reportedUrl, e.message);
                return errorResponse('Invalid URL format provided in report.', 400, corsHeaders);
            }

            if (domain) {
                // Check if this IP has already reported this domain recently
                const userReportKey = `REPORTED:${ip}:${domain}`;
                const alreadyReported = await LINKS_KV.get(userReportKey);

                if (alreadyReported !== null) {
                    return jsonResponse({ message: 'You have already reported this domain recently.' }, 429, corsHeaders); // 429 Too Many Requests
                }

                // Increment the global report count for the domain
                const reportCountKey = `REPORT_COUNT:${domain}`;
                let currentCount = parseInt(await LINKS_KV.get(reportCountKey) || '0');
                currentCount++;
                await LINKS_KV.put(reportCountKey, currentCount.toString());

                // Mark that this IP reported this domain (with TTL, e.g., 1 day = 86400 seconds)
                await LINKS_KV.put(userReportKey, "1", { expirationTtl: 86400 });

                console.log(`Report received for domain: ${domain} from IP: ${ip}. New count: ${currentCount}`);

                // Check threshold and automatically block if reached
                const BLOCK_THRESHOLD = 3; // Set the threshold
                if (currentCount >= BLOCK_THRESHOLD) {
                    const blockKey = `BLOCKED:${domain}`;
                    await LINKS_KV.put(blockKey, "auto"); // Value can indicate it was auto-blocked
                    console.log(`Domain automatically blocked due to report threshold: ${domain}`);
                     return jsonResponse({ message: 'Report submitted. Domain has been blocked due to multiple reports.' }, 200, corsHeaders);
                } else {
                     return jsonResponse({ message: 'Report submitted successfully. Thank you.' }, 200, corsHeaders);
                }
            } else {
                 // Should not happen if domain extraction logic is correct
                 return errorResponse('Could not extract domain from reported URL.', 500, corsHeaders);
            }

        } catch (e) {
            console.error("Error processing report:", e);
            return errorResponse(e.message || 'Failed to process report.', 500, corsHeaders);
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
