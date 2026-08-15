'use strict';

/**
 * youtube-api.js — официальный YouTube Data API v3 + OAuth 2.0 loopback.
 * Пароль Google не запрашивается и не хранится.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_SCOPE].join(' ');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';
const CHUNK = 8 * 1024 * 1024; // кратно 256 KiB

function jsonParse(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function request(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = options.body;
    const headers = { ...(options.headers || {}) };
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (payload && !headers['Content-Length']) headers['Content-Length'] = String(payload.length);
    const req = (url.protocol === 'http:' ? http : https).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function formBody(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value == null ? '' : String(value))}`)
    .join('&');
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const data = jsonParse(res.body);
  if (res.status >= 400 || data.error) {
    throw new Error(data.error_description || data.error || `OAuth token HTTP ${res.status}`);
  }
  return data;
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = jsonParse(res.body);
  if (res.status >= 400 || data.error) {
    throw new Error(data.error_description || data.error || `OAuth refresh HTTP ${res.status}`);
  }
  return data;
}

function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function runOAuthLoopback({ clientId, clientSecret, onOpenUrl, timeoutMs = 180000 }) {
  if (!clientId || !clientSecret) throw new Error('Укажите OAuth Client ID и Client Secret из Google Cloud.');
  let redirectUri = '';
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const err = url.searchParams.get('error');
        const oauthCode = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (err || !oauthCode) {
          res.end('<html><body style="font-family:sans-serif;padding:24px">Авторизация не удалась. Закройте окно.</body></html>');
          done(new Error(err || 'Нет кода авторизации'));
          return;
        }
        res.end('<html><body style="font-family:sans-serif;padding:24px">Канал подключён. Вернитесь в Shorts Inserter.</body></html>');
        done(null, oauthCode);
      } catch (error) {
        done(error);
      }
    });
    const timer = setTimeout(() => done(new Error('Истекло время ожидания входа Google')), timeoutMs);
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value);
    };
    server.on('error', (error) => done(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const url = authorizationUrl({ clientId, redirectUri, state: String(address.port) });
      if (typeof onOpenUrl === 'function') onOpenUrl(url);
    });
  });
  return exchangeCode({ clientId, clientSecret, code, redirectUri });
}

function privateUploadBody(title) {
  return {
    snippet: {
      title: String(title || 'copyright-check').slice(0, 100),
      description: 'Private copyright check. Not for publication.',
      categoryId: '22'
    },
    status: {
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      embeddable: false,
      publicStatsViewable: false
    }
  };
}

class YoutubeClient {
  constructor(options = {}) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tokens = options.tokens || null;
    this.now = options.now || (() => Date.now());
    this.request = options.request || request;
  }

  async ensureAccessToken() {
    if (!this.tokens || !this.tokens.refresh_token) {
      throw new Error('YouTube-канал не подключён. Нажмите «Проверить подключение».');
    }
    const expiresAt = Number(this.tokens.expires_at) || 0;
    if (this.tokens.access_token && expiresAt - 60_000 > this.now()) return this.tokens.access_token;
    const refreshed = await refreshAccessToken({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.tokens.refresh_token
    });
    this.tokens = {
      ...this.tokens,
      access_token: refreshed.access_token,
      expires_at: this.now() + (Number(refreshed.expires_in) || 3600) * 1000,
      token_type: refreshed.token_type || this.tokens.token_type
    };
    if (typeof this.onTokens === 'function') this.onTokens(this.tokens);
    return this.tokens.access_token;
  }

  async api(pathname, { method = 'GET', query = {}, body, headers } = {}) {
    const token = await this.ensureAccessToken();
    const url = new URL(`${API_BASE}${pathname}`);
    Object.entries(query).forEach(([key, value]) => {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    });
    const res = await this.request(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = jsonParse(res.body);
    if (res.status >= 400 || data.error) {
      const message = data.error && data.error.message ? data.error.message : `YouTube API HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  async getChannel() {
    const data = await this.api('/channels', { query: { part: 'snippet,id', mine: 'true' } });
    const channel = (data.items || [])[0];
    if (!channel) throw new Error('У этого Google-аккаунта нет YouTube-канала.');
    return {
      id: channel.id,
      title: channel.snippet && channel.snippet.title,
      customUrl: channel.snippet && channel.snippet.customUrl
    };
  }

  async getVideo(videoId) {
    const data = await this.api('/videos', {
      query: {
        part: 'snippet,status,contentDetails,processingDetails',
        id: videoId
      }
    });
    return (data.items || [])[0] || null;
  }

  async deleteVideo(videoId) {
    await this.api('/videos', { method: 'DELETE', query: { id: videoId } });
    return true;
  }

  async uploadPrivate(filePath, { title, onProgress } = {}) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('Локальный файл не найден');
    const stat = fs.statSync(filePath);
    const token = await this.ensureAccessToken();
    const start = await this.request(`${UPLOAD_BASE}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stat.size),
        'X-Upload-Content-Type': 'video/*'
      },
      body: JSON.stringify(privateUploadBody(title || path.basename(filePath)))
    });
    const location = start.headers.location || start.headers.Location;
    if (!location) throw new Error('YouTube не вернул URL для resumable upload');
    let offset = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      while (offset < stat.size) {
        const size = Math.min(CHUNK, stat.size - offset);
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, offset);
        const last = offset + size - 1;
        const res = await this.request(location, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'video/*',
            'Content-Length': String(size),
            'Content-Range': `bytes ${offset}-${last}/${stat.size}`
          },
          body: buf,
          timeout: 120000
        });
        if (res.status === 308) {
          const range = String(res.headers.range || '');
          const match = range.match(/bytes=0-(\d+)/);
          offset = match ? Number(match[1]) + 1 : offset + size;
        } else if (res.status >= 200 && res.status < 300) {
          offset = stat.size;
          if (typeof onProgress === 'function') onProgress(100);
          const data = jsonParse(res.body);
          if (!data.id) throw new Error('YouTube не вернул video id');
          if (data.status && data.status.privacyStatus && data.status.privacyStatus !== 'private') {
            throw new Error('Загрузка отклонена: видео не private');
          }
          return data;
        } else {
          throw new Error(`Upload HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 240)}`);
        }
        if (typeof onProgress === 'function') onProgress(Math.round((offset / stat.size) * 100));
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new Error('Загрузка оборвалась до получения video id');
  }
}

function loadTokenFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokenFile(file, tokens) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  SCOPES,
  YoutubeClient,
  runOAuthLoopback,
  authorizationUrl,
  exchangeCode,
  refreshAccessToken,
  loadTokenFile,
  saveTokenFile,
  privateUploadBody,
  request
};
