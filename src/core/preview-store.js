const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREVIEW_CACHE_FILE = path.join(__dirname, '..', '..', '.preview_cache.json');

/**
 * Two-Phase Commit / Preview Manager for all Setter operations.
 * Guarantees that no write operation can execute without first generating a Preview
 * and receiving user confirmation.
 * Persists pending action descriptors to disk so tokens survive MCP process restarts.
 */
class PreviewStore {
  constructor(ttlMs = 15 * 60 * 1000) {
    this.pending = new Map();
    this.ttlMs = ttlMs;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(PREVIEW_CACHE_FILE)) {
        const list = JSON.parse(fs.readFileSync(PREVIEW_CACHE_FILE, 'utf8'));
        const now = Date.now();
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.token && item.expiresAt > now) {
              this.pending.set(item.token, item);
            }
          }
        }
      }
    } catch (_) {
      // Ignore corrupt cache file
    }
  }

  _saveToDisk() {
    try {
      const serializable = Array.from(this.pending.values()).map(item => ({
        token: item.token,
        toolName: item.toolName,
        hash: item.hash,
        payloadKey: item.payloadKey,
        summary: item.summary,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt
      }));
      fs.writeFileSync(PREVIEW_CACHE_FILE, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (_) {
      // Ignore disk write errors
    }
  }

  _cleanup() {
    this._loadFromDisk();
    const now = Date.now();
    let changed = false;
    for (const [token, item] of this.pending.entries()) {
      if (now > item.expiresAt) {
        this.pending.delete(token);
        changed = true;
      }
    }
    if (changed) this._saveToDisk();
  }

  createHash(toolName, payloadKey) {
    return crypto
      .createHash('sha256')
      .update(`${toolName}:${JSON.stringify(payloadKey)}`)
      .digest('hex')
      .slice(0, 12);
  }

  /**
   * Registers a prepared preview and returns a preview_token.
   */
  register({ toolName, payloadKey, summary, executeFn }) {
    this._cleanup();
    const hash = this.createHash(toolName, payloadKey);
    const token = `prv_${hash}`;
    const now = Date.now();

    this.pending.set(token, {
      token,
      toolName,
      hash,
      payloadKey,
      summary,
      executeFn,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs
    });

    this._saveToDisk();
    return token;
  }

  /**
   * Checks if a valid preview already exists for either the given previewToken or the exact payload hash.
   */
  findValid(toolName, payloadKey, previewToken = null) {
    this._cleanup();
    if (previewToken && this.pending.has(previewToken)) {
      return this.pending.get(previewToken);
    }
    if (payloadKey) {
      const hash = this.createHash(toolName, payloadKey);
      const token = `prv_${hash}`;
      if (this.pending.has(token)) {
        return this.pending.get(token);
      }
    }
    return null;
  }

  getByToken(previewToken) {
    this._cleanup();
    return this.pending.get(previewToken) || null;
  }

  consume(previewToken) {
    const item = this.getByToken(previewToken);
    if (item) {
      this.pending.delete(previewToken);
      this._saveToDisk();
    }
    return item;
  }

  listPending() {
    this._cleanup();
    return Array.from(this.pending.values()).map(p => ({
      previewToken: p.token,
      toolName: p.toolName,
      createdAt: p.createdAt,
      summary: p.summary
    }));
  }
}

module.exports = { PreviewStore };
