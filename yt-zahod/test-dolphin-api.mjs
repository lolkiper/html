import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { parseUserAgentResponse, parseWebglFields } from './dolphin-api.mjs';

const baseDir = process.cwd();
const configPath = path.join(baseDir, 'onboard-config.json');

function normalizeToken(token) {
  return String(token || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '');
}

function normalizeCloudUrl(url) {
  let value = String(url || 'https://dolphin-anty-api.com').trim().replace(/\/$/, '');
  if (/dolphin-anty-api\.cc$/i.test(value)) {
    console.warn('⚠️ Cloud URL .cc заменён на .com');
    value = 'https://dolphin-anty-api.com';
  }
  return value;
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}... `);
  try {
    const result = await fn();
    console.log('OK');
    if (result !== undefined) console.log(result);
    return true;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const url = err.config?.url;
    console.log('FAIL');
    console.log(`   URL: ${url || '—'}`);
    console.log(`   HTTP: ${status || '—'} ${err.response?.statusText || ''}`);
    console.log(`   Ответ: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    console.log(`   Сообщение: ${err.message}`);
    return false;
  }
}

if (!fs.existsSync(configPath)) {
  console.error(`❌ Не найден ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const token = normalizeToken(config.DOLPHIN_TOKEN);
const localApi = (config.DOLPHIN_LOCAL_API_URL || config.DOLPHIN_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const cloudApi = normalizeCloudUrl(config.DOLPHIN_CLOUD_API_URL);

console.log('=== Проверка Dolphin API ===');
console.log(`Папка: ${baseDir}`);
console.log(`Local API: ${localApi}`);
console.log(`Cloud API: ${cloudApi}`);
console.log(`Токен: ${token ? `${token.slice(0, 8)}...${token.slice(-4)} (${token.length} символов)` : 'ПУСТО'}`);

if (!token) {
  console.error('\n❌ DOLPHIN_TOKEN пустой в onboard-config.json');
  process.exit(1);
}

let ok = true;

ok = await step('Локальная авторизация POST /v1.0/auth/login-with-token', async () => {
  const { data } = await axios.post(
    `${localApi}/v1.0/auth/login-with-token`,
    { token },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return JSON.stringify(data);
}) && ok;

ok = await step('Cloud GET /browser_profiles', async () => {
  const { data } = await axios.get(`${cloudApi}/browser_profiles`, {
    params: { limit: 1, page: 1 },
    headers: authHeaders(token),
  });
  const count = Array.isArray(data?.data) ? data.data.length : '?';
  return `профилей в ответе: ${count}, всего: ${data?.total ?? '?'}`;
}) && ok;

ok = await step('Cloud GET /fingerprints/useragent', async () => {
  const { data } = await axios.get(`${cloudApi}/fingerprints/useragent`, {
    params: { browser_type: 'anty', browser_version: '140', platform: 'windows' },
    headers: authHeaders(token),
  });
  const ua = parseUserAgentResponse(data);
  return ua ? `UA: ${String(ua).slice(0, 60)}...` : JSON.stringify(data);
}) && ok;

ok = await step('Cloud GET /fingerprints/webgl', async () => {
  const { data } = await axios.get(`${cloudApi}/fingerprints/webgl`, {
    params: { browser_type: 'anty', platform: 'windows' },
    headers: authHeaders(token),
  });
  return JSON.stringify(data).slice(0, 120) + '...';
}) && ok;

ok = await step('Cloud POST /browser_profiles (тестовый профиль)', async () => {
  const uaResp = await axios.get(`${cloudApi}/fingerprints/useragent`, {
    params: { browser_type: 'anty', browser_version: '140', platform: 'windows' },
    headers: authHeaders(token),
  });
  const webglResp = await axios.get(`${cloudApi}/fingerprints/webgl`, {
    params: { browser_type: 'anty', platform: 'windows' },
    headers: authHeaders(token),
  });
  const userAgent = parseUserAgentResponse(uaResp.data);
  const webgl = parseWebglFields(webglResp.data);
  const payload = {
    name: `API-TEST-${Date.now()}`,
    platform: 'windows',
    browserType: 'anty',
    mainWebsite: '',
    useragent: { mode: 'manual', value: userAgent },
    webrtc: { mode: 'altered', ipAddress: null },
    canvas: { mode: 'real' },
    webgl: { mode: 'real' },
    webglInfo: {
      mode: 'manual',
      vendor: webgl.vendor,
      renderer: webgl.renderer,
      webgl2Maximum: webgl.webgl2Maximum,
    },
    timezone: { mode: 'auto', value: null },
    locale: { mode: 'auto', value: null },
    cpu: { mode: 'manual', value: 4 },
    memory: { mode: 'manual', value: 8 },
    screen: { mode: null, resolution: null },
    doNotTrack: false,
    osVersion: '10',
  };
  const { data } = await axios.post(`${cloudApi}/browser_profiles`, payload, {
    headers: authHeaders(token),
  });
  return JSON.stringify(data);
}) && ok;

console.log(ok ? '\n✅ Все проверки прошли — API работает.' : '\n❌ Есть ошибки. Смотрите шаг выше.');
process.exit(ok ? 0 : 1);
