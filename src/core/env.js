const fs = require('fs');
const path = require('path');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

/**
 * Loads environment variables from .env file silently.
 * Never writes anything to stdout (crucial for MCP stdio protocol integrity).
 */
function loadEnv(envPath = DEFAULT_ENV_PATH) {
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.error('[env] Warning: failed to read .env:', err.message);
  }
}

module.exports = { loadEnv };
