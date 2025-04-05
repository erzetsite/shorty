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
  headers['Access-Control-Allow-Origin'] = '*'; // Allow requests from any origin (adjust for production)
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  return new Response(JSON.stringify(data), { status, headers });
}

// Helper to return error responses
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
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

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400', // Cache preflight response for 1 day
        },
      });
    }

    // API endpoint for creating short links
    if (path === '/api/create' && method === 'POST') {
      try {
        const { longUrl } = await request.json();
        if (!longUrl) {
          return errorResponse('Missing longUrl parameter');
        }
        // Basic URL validation (consider more robust validation)
        try {
            new URL(longUrl);
        } catch (_) {
            return errorResponse('Invalid URL format provided.');
        }


        let shortId;
        let attempts = 0;
        const maxAttempts = 5; // Prevent infinite loops in case of unlikely collisions

        // Generate a unique short ID
        do {
          shortId = generateShortId();
          attempts++;
          if (attempts > maxAttempts) {
            return errorResponse('Failed to generate a unique short ID.', 500);
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

        const shortUrl = `${url.origin}/${shortId}`; // Construct the full short URL
        return jsonResponse({ shortUrl, originalUrl: longUrl });

      } catch (e) {
        console.error("Error creating link:", e);
        return errorResponse(e.message || 'Failed to create short link.', 500);
      }
    }

    // API endpoint for checking stats
    if (path.startsWith('/api/stats/') && method === 'GET') {
        const shortId = path.substring('/api/stats/'.length);
         if (!shortId) {
            return errorResponse('Missing short ID in path.');
        }

        try {
            const metadataJson = await LINKS_KV.get(`${shortId}_meta`);
            if (!metadataJson) {
                return errorResponse('Short URL not found.', 404);
            }
            const metadata = JSON.parse(metadataJson);
            return jsonResponse(metadata);
        } catch (e) {
            console.error("Error fetching stats:", e);
            return errorResponse(e.message || 'Failed to fetch stats.', 500);
        }
    }

    // Redirect short links
    if (path !== '/' && path !== '/api/create' && !path.startsWith('/api/stats/')) {
      const shortId = path.substring(1); // Remove leading '/'

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
           return new Response('Short URL not found.', { status: 404 });
        }
      } catch (e) {
         console.error("Error during redirect:", e);
         return new Response('An error occurred.', { status: 500 });
      }
    }

    // Serve the index.html file for the root path
    // Note: In a real deployment, you'd likely use Cloudflare Pages for the static site
    // and have the worker handle only API/redirects.
    // This basic example returns a simple message for the root.
    if (path === '/') {
       return new Response('Welcome to Shorty! Use the frontend to create links.', {
            headers: { 'Content-Type': 'text/plain' },
       });
    }

    return new Response('Not Found', { status: 404 });
  },
};
