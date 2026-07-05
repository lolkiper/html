const $ = (id) => document.getElementById(id);

const els = {
  dolphinToken: $('dolphinToken'),
  localApi: $('localApi'),
  cloudApi: $('cloudApi'),
  delayMs: $('delayMs'),
  channelsText: $('channelsText'),
  statsBody: $('statsBody'),
  updatedAt: $('updatedAt'),
  logBox: $('logBox'),
  statusBadge: $('statusBadge'),
  pathsInfo: $('pathsInfo'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnSaveConfig: $('btnSaveConfig'),
  btnSaveChannels: $('btnSaveChannels'),
  btnRefresh: $('btnRefresh'),
  btnClearLog: $('btnClearLog'),
};

function appendLog(line) {
  els.logBox.textContent += `${line}\n`;
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setStatus(status) {
  const running = status === 'running';
  els.statusBadge.textContent = running ? 'Сбор данных...' : 'Готов';
  els.statusBadge.className = `status-badge ${running ? 'running' : 'idle'}`;
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function statusClass(status) {
  if (status === 'OK') return 'status-ok';
  if (status === 'BLOCKED') return 'status-blocked';
  return 'status-err';
}

function readConfigFromForm() {
  const cloudApi = els.cloudApi.value.trim().replace(/\/$/, '');
  return {
    DOLPHIN_TOKEN: els.dolphinToken.value.trim().replace(/^Bearer\s+/i, ''),
    DOLPHIN_LOCAL_API_URL: els.localApi.value.trim(),
    DOLPHIN_CLOUD_API_URL: /dolphin-anty-api\.cc$/i.test(cloudApi)
      ? 'https://dolphin-anty-api.com'
      : cloudApi,
    DELAY_BETWEEN_CHANNELS_MS: Number(els.delayMs.value) || 5000,
    ACCOUNTS_FILE: 'accounts.txt',
    CHANNELS_FILE: 'channels.txt',
    STATS_RESULTS_FILE: 'channel-stats-results.json',
    TOTP_WEBSITE: 'https://2fa.fb.tools/',
    PLATFORM: 'windows',
    BROWSER_VERSION: '140',
    HEADLESS: false,
  };
}

function fillConfigForm(config) {
  els.dolphinToken.value = config.DOLPHIN_TOKEN || '';
  els.localApi.value = config.DOLPHIN_LOCAL_API_URL || config.DOLPHIN_API_URL || 'http://localhost:3001';
  els.cloudApi.value = config.DOLPHIN_CLOUD_API_URL || 'https://dolphin-anty-api.com';
  els.delayMs.value = config.DELAY_BETWEEN_CHANNELS_MS ?? config.DELAY_BETWEEN_ACCOUNTS_MS ?? 5000;
}

async function refreshStats() {
  const data = await window.statsPanel.loadResults();
  const channels = data.channels || [];

  if (data.updatedAt) {
    els.updatedAt.textContent = `Обновлено: ${new Date(data.updatedAt).toLocaleString('ru-RU')}`;
  } else {
    els.updatedAt.textContent = 'Обновлено: —';
  }

  if (!channels.length) {
    els.statsBody.innerHTML = '<tr><td colspan="9" class="empty-row">Нет данных — нажмите «Собрать статистику»</td></tr>';
    return;
  }

  els.statsBody.innerHTML = channels.map((c) => {
    const statusText = c.status === 'BLOCKED'
      ? `ЗАБЛОКИРОВАН${c.blockReason ? `: ${c.blockReason}` : ''}`
      : (c.status || '—');
    const errHint = c.error ? `<div class="meta-small">${escapeHtml(c.error)}</div>` : '';

    return `<tr>
      <td><span class="channel-num">${c.channelNumber}</span></td>
      <td>
        <div>${escapeHtml(c.channelName || '—')}</div>
        <div class="meta-small">${escapeHtml(c.channelId || '')}</div>
        ${c.profileId ? `<div class="meta-small">Profile: ${escapeHtml(c.profileId)}</div>` : ''}
      </td>
      <td>
        <div>${escapeHtml(c.email || '—')}</div>
        <div class="meta-small">${escapeHtml(c.profileName || '')}</div>
      </td>
      <td>${escapeHtml(c.subscribers || '—')}</td>
      <td>${escapeHtml(c.totalViews || '—')}</td>
      <td>
        <div>${escapeHtml(c.lastVideoTitle || '—')}</div>
        ${c.lastVideoUrl ? `<div class="meta-small"><a href="${escapeHtml(c.lastVideoUrl)}" style="color:var(--accent)">ссылка</a></div>` : ''}
      </td>
      <td>${escapeHtml(c.lastVideoViews || '—')}</td>
      <td>${escapeHtml(c.lastVideoDate || '—')}</td>
      <td class="${statusClass(c.status)}">${escapeHtml(statusText)}${errHint}</td>
    </tr>`;
  }).join('');
}

async function init() {
  const paths = await window.statsPanel.getPaths();
  els.pathsInfo.textContent = `Папка: ${paths.baseDir} | accounts.txt | channels.txt | onboard-results.json`;

  const config = await window.statsPanel.loadConfig();
  fillConfigForm(config);

  els.channelsText.value = await window.statsPanel.loadChannels();
  await refreshStats();

  const running = await window.statsPanel.isRunning();
  setStatus(running ? 'running' : 'idle');

  appendLog('[SYSTEM] Панель статистики инициализирована');
  appendLog('[INFO] Канал №1 = первая строка channels.txt = первый аккаунт accounts.txt');
  appendLog('[READY] Нажмите «Собрать статистику» для запуска');

  window.statsPanel.onLog(appendLog);
  window.statsPanel.onStatus(setStatus);
  window.statsPanel.onStatsFinished(refreshStats);

  setInterval(refreshStats, 5000);
}

els.btnSaveConfig.addEventListener('click', async () => {
  await window.statsPanel.saveConfig(readConfigFromForm());
  appendLog('[Panel] stats-config.json сохранён');
});

els.btnSaveChannels.addEventListener('click', async () => {
  await window.statsPanel.saveChannels(els.channelsText.value);
  appendLog('[Panel] channels.txt сохранён');
});

els.btnStart.addEventListener('click', async () => {
  try {
    await window.statsPanel.saveConfig(readConfigFromForm());
    await window.statsPanel.saveChannels(els.channelsText.value);
    await window.statsPanel.startStats();
    appendLog('[Panel] Сбор статистики запущен');
  } catch (err) {
    appendLog(`[Panel] Ошибка старта: ${err.message}`);
  }
});

els.btnStop.addEventListener('click', async () => {
  await window.statsPanel.stopStats();
});

els.btnRefresh.addEventListener('click', refreshStats);
els.btnClearLog.addEventListener('click', () => { els.logBox.textContent = ''; });

init().catch((err) => appendLog(`[Panel] Init error: ${err.message}`));
