const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { loadEnv } = require('./env');

loadEnv();

const DEFAULT_COOKIES_PATH = path.join(__dirname, '..', '..', 'cookies.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class SchoolTodayClient {
  constructor(cookiesPath = DEFAULT_COOKIES_PATH) {
    this.cookiesPath = cookiesPath;
    this.baseURL = process.env.SCHOOL_TODAY_BASE_URL || 'https://school-today.com';
    this.timeoutMs = Number(process.env.SCHOOL_TODAY_TIMEOUT_MS) || 15000;
    this.cookies = new Map();
    this.lastAuthAt = null;
    this._loginPromise = null;
    this._loadCookiesFromDisk();
  }

  _loadCookiesFromDisk() {
    try {
      if (fs.existsSync(this.cookiesPath)) {
        const list = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
        if (Array.isArray(list)) {
          this.cookies.clear();
          for (const c of list) {
            if (c && c.name && c.value !== undefined) {
              this.cookies.set(c.name, {
                name: c.name,
                value: c.value,
                domain: c.domain || 'school-today.com',
                path: c.path || '/',
                expires: c.expires ?? -1
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[client] Warning: could not parse cookies.json:', err.message);
    }
  }

  _saveCookiesToDisk() {
    try {
      const arr = Array.from(this.cookies.values());
      fs.writeFileSync(this.cookiesPath, JSON.stringify(arr, null, 2), 'utf8');
    } catch (err) {
      console.error('[client] Warning: could not write cookies.json:', err.message);
    }
  }

  _ingestSetCookieHeaders(setCookieHeader) {
    if (!setCookieHeader || !Array.isArray(setCookieHeader) || setCookieHeader.length === 0) {
      return;
    }
    let changed = false;
    for (const raw of setCookieHeader) {
      const parts = raw.split(';').map(s => s.trim());
      const [nameVal, ...attrs] = parts;
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = nameVal.slice(0, eqIdx).trim();
      const value = nameVal.slice(eqIdx + 1).trim();

      let expires = -1;
      for (const attr of attrs) {
        if (attr.toLowerCase().startsWith('expires=')) {
          const parsed = Date.parse(attr.slice(8));
          if (!isNaN(parsed)) expires = Math.floor(parsed / 1000);
        }
      }

      if (!value || (expires > 0 && expires * 1000 < Date.now())) {
        if (this.cookies.has(name)) {
          this.cookies.delete(name);
          changed = true;
        }
      } else {
        this.cookies.set(name, {
          name,
          value,
          domain: 'school-today.com',
          path: '/',
          expires
        });
        changed = true;
      }
    }
    if (changed) {
      this._saveCookiesToDisk();
    }
  }

  getCookieHeader() {
    return Array.from(this.cookies.values())
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  hasValidIdentityCookie() {
    const idCookie = this.cookies.get('.AspNetCore.Identity.Application');
    if (!idCookie || !idCookie.value) return false;
    if (idCookie.expires && idCookie.expires > 0) {
      // Consider expired if less than 2 minutes remaining
      if (idCookie.expires * 1000 < Date.now() + 120 * 1000) {
        return false;
      }
    }
    return true;
  }

  getAuthDiagnostics() {
    const idCookie = this.cookies.get('.AspNetCore.Identity.Application');
    const expiresIso =
      idCookie && idCookie.expires > 0
        ? new Date(idCookie.expires * 1000).toISOString()
        : idCookie
        ? 'session'
        : null;
    const hasEnvCredentials = Boolean(
      process.env.SCHOOL_TODAY_EMAIL && process.env.SCHOOL_TODAY_PASSWORD
    );
    return {
      hasActiveCookie: this.hasValidIdentityCookie(),
      cookieExpiresAt: expiresIso,
      autoLoginConfigured: hasEnvCredentials,
      accountEmail: process.env.SCHOOL_TODAY_EMAIL || null,
      lastAuthAt: this.lastAuthAt,
      readOnlyLock: process.env.SCHOOL_TODAY_READ_ONLY === 'true'
    };
  }

  /**
   * Automatic direct login via /Account/Login using credentials from .env
   */
  async loginWithCredentials() {
    if (this._loginPromise) {
      return this._loginPromise;
    }

    this._loginPromise = (async () => {
      const email = process.env.SCHOOL_TODAY_EMAIL;
      const password = process.env.SCHOOL_TODAY_PASSWORD;
      if (!email || !password) {
        throw new Error(
          '⚠️ СЕСІЯ ЗАКІНЧИЛАСЯ: облікові дані (SCHOOL_TODAY_EMAIL / SCHOOL_TODAY_PASSWORD) не налаштовані в .env. Додайте їх у .env або запустіть "npm run auth".'
        );
      }

      const getRes = await axios.get(`${this.baseURL}/Account/Login`, {
        timeout: this.timeoutMs,
        headers: { 'User-Agent': USER_AGENT }
      });

      this.cookies.clear();
      this._ingestSetCookieHeaders(getRes.headers['set-cookie']);

      const $ = cheerio.load(getRes.data);
      const loginForm = $('form[action*="/Account/Login"]').first();
      const csrfToken = loginForm.find('input[name="__RequestVerificationToken"]').val();
      if (!csrfToken) {
        throw new Error('Не вдалося отримати CSRF-токен зі сторінки /Account/Login.');
      }

      const params = new URLSearchParams();
      params.append('Step', loginForm.find('input[name="Step"]').val() || 'Login');
      params.append('Verification', loginForm.find('input[name="Verification"]').val() || '');
      params.append('Email', email);
      params.append('Password', password);
      params.append('RememberMe', 'true');
      params.append('__RequestVerificationToken', csrfToken);

      const postRes = await axios.post(`${this.baseURL}/Account/Login`, params.toString(), {
        timeout: this.timeoutMs,
        headers: {
          'Cookie': this.getCookieHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${this.baseURL}/Account/Login`,
          'User-Agent': USER_AGENT
        },
        maxRedirects: 0,
        validateStatus: () => true
      });

      this._ingestSetCookieHeaders(postRes.headers['set-cookie']);

      if (!this.cookies.has('.AspNetCore.Identity.Application')) {
        const $err = cheerio.load(postRes.data || '');
        const errText = $err('.validation-summary-errors, .text-danger')
          .text()
          .replace(/\s+/g, ' ')
          .trim();
        throw new Error(
          `Помилка автоматичного входу до School-Today: ${errText || `HTTP ${postRes.status}`}`
        );
      }

      this.lastAuthAt = new Date().toISOString();
      return true;
    })();

    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  async ensureAuthenticated() {
    if (!this.hasValidIdentityCookie()) {
      this._loadCookiesFromDisk();
      if (!this.hasValidIdentityCookie()) {
        await this.loginWithCredentials();
      }
    }
  }

  _isLoginRedirect(response) {
    const dataStr = typeof response.data === 'string' ? response.data : '';
    const finalUrl =
      (response.request && response.request.res && response.request.res.responseUrl) || '';
    const locationHeader = response.headers && response.headers.location ? response.headers.location : '';
    return (
      finalUrl.includes('/Account/Login') ||
      locationHeader.includes('/Account/Login') ||
      dataStr.includes('ЗАЛОГУЙТЕСЬ ЩОБ ПРОДОВЖИТИ')
    );
  }

  async _request(method, url, data = undefined, config = {}, retryCount = 0) {
    if (method === 'POST' && process.env.SCHOOL_TODAY_READ_ONLY === 'true') {
      throw new Error(
        '🔒 Запис заблоковано: увімкнено режим захисту SCHOOL_TODAY_READ_ONLY=true.'
      );
    }

    await this.ensureAuthenticated();

    try {
      const response = await axios({
        method,
        url,
        baseURL: this.baseURL,
        data,
        timeout: config.timeout || this.timeoutMs,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
        ...config,
        headers: {
          'Cookie': this.getCookieHeader(),
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(config.headers || {})
        }
      });

      this._ingestSetCookieHeaders(response.headers['set-cookie']);

      if (this._isLoginRedirect(response)) {
        if (retryCount < 1) {
          this.cookies.delete('.AspNetCore.Identity.Application');
          await this.loginWithCredentials();
          return this._request(method, url, data, config, retryCount + 1);
        }
        throw new Error(
          '⚠️ СЕСІЯ ЗАКІНЧИЛАСЯ: School Today вимагає авторизації навіть після спроби автоматичного входу.'
        );
      }

      return response;
    } catch (err) {
      const isTransient =
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNABORTED' ||
        (err.response && [502, 503, 504].includes(err.response.status));

      if (isTransient && retryCount < 2) {
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        return this._request(method, url, data, config, retryCount + 1);
      }
      throw err;
    }
  }

  async get(url, config = {}) {
    return this._request('GET', url, undefined, config);
  }

  async post(url, data, config = {}) {
    return this._request('POST', url, data, config);
  }
}

module.exports = { SchoolTodayClient };
