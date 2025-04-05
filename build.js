const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.html');

// Read environment variables provided by Cloudflare Pages build environment
// Use || '' for optional variables to avoid 'undefined' string
const apiUrl = process.env.PUBLIC_API_WORKER_URL;
const turnstileKey = process.env.PUBLIC_TURNSTILE_SITE_KEY;
const shortDomain = process.env.PUBLIC_SHORT_DOMAIN;
const umamiScript = process.env.PUBLIC_UMAMI_SCRIPT_URL || '';
const umamiId = process.env.PUBLIC_UMAMI_WEBSITE_ID || '';

// Check for required variables
if (!apiUrl || !turnstileKey || !shortDomain) {
  console.error('Error: Missing required environment variables (PUBLIC_API_WORKER_URL, PUBLIC_TURNSTILE_SITE_KEY, PUBLIC_SHORT_DOMAIN)');
  process.exit(1);
}

try {
  let htmlContent = fs.readFileSync(indexPath, 'utf8');

  // Replace placeholders in the window.shortyConfig block
  // Use specific, unique placeholders
  htmlContent = htmlContent.replace('__API_WORKER_URL__', apiUrl);
  htmlContent = htmlContent.replace('__TURNSTILE_SITE_KEY__', turnstileKey);
  htmlContent = htmlContent.replace('__SHORT_DOMAIN__', shortDomain);
  htmlContent = htmlContent.replace('__UMAMI_SCRIPT_URL__', umamiScript);
  htmlContent = htmlContent.replace('__UMAMI_WEBSITE_ID__', umamiId);

  // Overwrite the original index.html file
  fs.writeFileSync(indexPath, htmlContent, 'utf8');

  console.log('Build successful: index.html updated with environment variables.');

} catch (error) {
  console.error('Error during build process:', error);
  process.exit(1);
}
