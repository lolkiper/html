import axios from 'axios';

const DEFAULT_CLOUD = 'https://dolphin-anty-api.com';

export function normalizeToken(token) {
  return String(token || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '');
}

export function normalizeCloudUrl(url) {
  let value = String(url || DEFAULT_CLOUD).trim().replace(/\/$/, '');
  if (/dolphin-anty-api\.cc$/i.test(value)) {
    value = DEFAULT_CLOUD;
  }
  return value;
}

export function parseUserAgentResponse(data) {
  if (typeof data === 'string') return data;
  if (typeof data?.data === 'string') return data.data;
  if (typeof data?.value === 'string') return data.value;
  if (typeof data?.useragent === 'string') return data.useragent;
  return null;
}

export function parseWebglFields(webglInfo) {
  const webgl = webglInfo?.webgl || webglInfo || {};
  return {
    vendor: webgl.vendor || webgl.webgl_unmasked_vendor || 'Google Inc. (Intel)',
    renderer: webgl.renderer || webgl.webgl_unmasked_renderer
      || 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webgl2Maximum: webgl.webgl2Maximum || webgl.webgl2maximum || webgl.webgl2_maximum
      || '{"UNIFORM_BUFFER_OFFSET_ALIGNMENT":256,"MAX_TEXTURE_SIZE":16384}',
  };
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

function formatApiError(err, context) {
  if (!err?.response) {
    return `${context}: ${err?.message || String(err)}`;
  }

  const { status, statusText, data } = err.response;
  const url = err.config?.url || '';
  const body = typeof data === 'string'
    ? data
    : data?.message || data?.error || JSON.stringify(data);

  let hint = '';
  if (status === 401) {
    hint = ' Проверьте DOLPHIN_TOKEN: создайте новый на https://dolphin-anty.com/panel → API.';
  } else if (status === 403) {
    hint = [
      ' Cloud API отклонил запрос. Частые причины:',
      '1) бесплатный тариф Free — создание профилей через API недоступно (нужен Free+/Starter);',
      '2) истёк или неверный токен;',
      '3) неверный Cloud API URL (обычно https://dolphin-anty-api.com, не .cc);',
      '4) лимит профилей на аккаунте.',
    ].join('');
  }

  return `${context}: HTTP ${status} ${statusText}${url ? ` (${url})` : ''} — ${body}.${hint}`;
}

async function axiosCall(promise, context) {
  try {
    return await promise;
  } catch (err) {
    throw new Error(formatApiError(err, context));
  }
}

export class DolphinClient {
  constructor({ localApiUrl, cloudApiUrl, token }) {
    this.localApiUrl = (localApiUrl || 'http://localhost:3001').replace(/\/$/, '');
    this.cloudApiUrl = normalizeCloudUrl(cloudApiUrl);
    this.token = normalizeToken(token);
  }

  async loginWithToken() {
    const { data } = await axiosCall(
      axios.post(
        `${this.localApiUrl}/v1.0/auth/login-with-token`,
        { token: this.token },
        { headers: { 'Content-Type': 'application/json' } }
      ),
      'Локальный Dolphin API'
    );
    return data;
  }

  async verifyCloudAccess() {
    if (!this.token?.trim()) {
      throw new Error('DOLPHIN_TOKEN пустой. Вставьте токен из https://dolphin-anty.com/panel → API.');
    }

    await axiosCall(
      axios.get(`${this.cloudApiUrl}/browser_profiles`, {
        params: { limit: 1, page: 1 },
        headers: authHeaders(this.token),
      }),
      'Проверка Cloud API Dolphin'
    );
  }

  async fetchUserAgent(platform = 'windows', browserVersion = '140') {
    const { data } = await axiosCall(
      axios.get(`${this.cloudApiUrl}/fingerprints/useragent`, {
        params: { browser_type: 'anty', browser_version: browserVersion, platform },
        headers: authHeaders(this.token),
      }),
      'Запрос fingerprint user-agent'
    );
    const userAgent = parseUserAgentResponse(data);
    if (!userAgent) {
      throw new Error(`Dolphin не вернул user-agent: ${JSON.stringify(data)}`);
    }
    return userAgent;
  }

  async fetchWebglInfo(platform = 'windows') {
    const { data } = await axiosCall(
      axios.get(`${this.cloudApiUrl}/fingerprints/webgl`, {
        params: { browser_type: 'anty', platform },
        headers: authHeaders(this.token),
      }),
      'Запрос fingerprint WebGL'
    );
    return data;
  }

  buildProxyPayload(proxy) {
    if (!proxy?.host || !proxy?.port) return null;
    return {
      type: proxy.type || 'http',
      host: String(proxy.host),
      port: String(proxy.port),
      login: proxy.login || proxy.user || '',
      password: proxy.password || proxy.pass || '',
    };
  }

  async createProfile(options = {}) {
    const {
      name,
      proxy,
      platform = 'windows',
      browserVersion = '140',
      mainWebsite = '',
    } = options;

    const [userAgent, webglInfo] = await Promise.all([
      this.fetchUserAgent(platform, browserVersion),
      this.fetchWebglInfo(platform),
    ]);

    const webgl = parseWebglFields(webglInfo);
    const payload = {
      name: name || `YT-${Date.now()}`,
      platform,
      browserType: 'anty',
      mainWebsite: mainWebsite ?? '',
      useragent: {
        mode: 'manual',
        value: userAgent,
      },
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

    const proxyPayload = this.buildProxyPayload(proxy);
    if (proxyPayload) payload.proxy = proxyPayload;

    const { data } = await axiosCall(
      axios.post(
        `${this.cloudApiUrl}/browser_profiles`,
        payload,
        { headers: authHeaders(this.token) }
      ),
      'Создание профиля Dolphin'
    );

    const profileId = data?.browserProfileId || data?.id || data?.data?.id;
    if (!profileId) {
      throw new Error(`Dolphin не вернул ID профиля: ${JSON.stringify(data)}`);
    }
    return { profileId: String(profileId), raw: data };
  }

  async startProfile(profileId, { headless = false } = {}) {
    const url = `${this.localApiUrl}/v1.0/browser_profiles/${profileId}/start?automation=1${headless ? '&headless=1' : ''}`;
    const { data } = await axios.get(url, { headers: authHeaders(this.token) });
    if (!data?.automation?.port || !data?.automation?.wsEndpoint) {
      throw new Error(`Dolphin не отдал automation: ${JSON.stringify(data)}`);
    }
    const { port, wsEndpoint } = data.automation;
    const wsUrl = wsEndpoint.startsWith('ws://')
      ? wsEndpoint
      : `ws://127.0.0.1:${port}${wsEndpoint}`;
    return { port, wsEndpoint, wsUrl, raw: data };
  }

  async stopProfile(profileId) {
    const { data } = await axios.get(
      `${this.localApiUrl}/v1.0/browser_profiles/${profileId}/stop`,
      { headers: authHeaders(this.token) }
    ).catch(() => ({ data: { success: false } }));
    return data;
  }
}
