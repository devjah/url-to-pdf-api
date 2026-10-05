const { URL } = require('url');

// The app's render URLs carry an internal api_token in their query string, so a log line gets
// the URL without it.
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (err) {
    return '<unparseable url>';
  }
}

module.exports = redactUrl;
