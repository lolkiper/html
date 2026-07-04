import axios from 'axios';

const DEFAULT_CLOUD = 'https://dolphin-anty-api.com';

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

export class DolphinClient {
  constructor({ localApiUrl, cloudApiUrl, token }) {
    this.localApiUrl = (localApiUrl || 'http://localhost:3001').replace(/\/$/, '');
    this.cloudApiUrl = (cloudApiUrl || DEFAULT_CLOUD).replace(/\/$/, '');
    this.token = token;
  }

  async loginWithToken() {
    const { data } = await axios.post(
      `${this.localApiUrl}/v1.0/auth/login-with-token`,
      { token: this.token },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return data;
  }

  async fetchUserAgent(platform = 'windows', browserVersion = '140') {
    const { data } = await axios.get(`${this.cloudApiUrl}/fingerprints/useragent`, {
      params: { browser_type: 'anty', browser_version: browserVersion, platform },
      headers: authHeaders(this.token),
    });
    return typeof data === 'string' ? data : data?.value || data?.useragent || data;
  }

  async fetchWebglInfo(platform = 'windows') {
    const { data } = await axios.get(`${this.cloudApiUrl}/fingerprints/webgl`, {
      params: { browser_type: 'anty', platform },
      headers: authHeaders(this.token),
    });
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

  async createProfile({ name, proxy, platform = 'windows', browserVersion = '140' }) {
    const [userAgent, webglInfo] = await Promise.all([
      this.fetchUserAgent(platform, browserVersion),
      this.fetchWebglInfo(platform),
    ]);

    const webgl = webglInfo?.webgl || webglInfo;
    const payload = {
      name: name || `YT-${Date.now()}`,
      platform,
      browserType: 'anty',
      mainWebsite: 'google',
      useragent: {
        mode: 'manual',
        value: typeof userAgent === 'string' ? userAgent : userAgent?.value,
      },
      webrtc: { mode: 'altered', ipAddress: null },
      canvas: { mode: 'real' },
      webgl: { mode: 'real' },
      webglInfo: {
        mode: 'manual',
        vendor: webgl?.vendor || 'Google Inc. (Intel)',
        renderer: webgl?.renderer || 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
        webgl2Maximum: webgl?.webgl2Maximum || webgl?.webgl2maximum || '{"UNIFORM_BUFFER_OFFSET_ALIGNMENT":256,"MAX_TEXTURE_SIZE":16384}',
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

    const { data } = await axios.post(
      `${this.cloudApiUrl}/browser_profiles`,
      payload,
      { headers: authHeaders(this.token) }
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
