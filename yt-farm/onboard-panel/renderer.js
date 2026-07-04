const $ = (id) => document.getElementById(id);

const els = {
  dolphinToken: $('dolphinToken'),
  localApi: $('localApi'),
  cloudApi: $('cloudApi'),
  totpSite: $('totpSite'),
  delayMs: $('delayMs'),
  skipOk: $('skipOk'),
  accountsText: $('accountsText'),
  resultsBody: $('resultsBody'),
  logBox: $('logBox'),
  statusBadge: $('statusBadge'),
  pathsInfo: $('pathsInfo'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnSaveConfig: $('btnSaveConfig'),
  btnSaveAccounts: $('btnSaveAccounts'),
  btnRefreshResults: $('btnRefreshResults'),
  btnClearLog: $('btnClearLog'),
};

function appendLog(line) {
  els.logBox.textContent += `${line}\n`;
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setStatus(status) {
  const running = status === 'running';
  els.statusBadge.textContent = running ? 'Работает' : 'Готов';
  els.statusBadge.className = `badge ${running ? 'running' : 'idle'}`;
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
}

function readConfigFromForm() {
  return {
    DOLPHIN_TOKEN: els.dolphinToken.value.trim(),
    DOLPHIN_LOCAL_API_URL: els.localApi.value.trim(),
    DOLPHIN_CLOUD_API_URL: els.cloudApi.value.trim(),
    TOTP_WEBSITE: els.totpSite.value.trim(),
    DELAY_BETWEEN_ACCOUNTS_MS: Number(els.delayMs.value) || 5000,
    SKIP_ALREADY_OK: els.skipOk.checked,
    ACCOUNTS_FILE: 'accounts.txt',
    PLATFORM: 'windows',
    BROWSER_VERSION: '140',
    HEADLESS: false,
  };
}

function fillConfigForm(config) {
  els.dolphinToken.value = config.DOLPHIN_TOKEN || '';
  els.localApi.value = config.DOLPHIN_LOCAL_API_URL || config.DOLPHIN_API_URL || 'http://localhost:3001';
  els.cloudApi.value = config.DOLPHIN_CLOUD_API_URL || 'https://dolphin-anty-api.com';
  els.totpSite.value = config.TOTP_WEBSITE || 'https://2fa.live/';
  els.delayMs.value = config.DELAY_BETWEEN_ACCOUNTS_MS ?? 5000;
  els.skipOk.checked = config.SKIP_ALREADY_OK !== false;
}

async function refreshResults() {
  const data = await window.onboardPanel.loadResults();
  const rows = (data.accounts || []).map((a) => {
    const cls = a.status === 'OK' ? 'status-ok' : 'status-err';
    return `<tr>
      <td>${escapeHtml(a.email || '')}</td>
      <td><code>${escapeHtml(a.profileId || '—')}</code></td>
      <td class="${cls}">${escapeHtml(a.status || '')}</td>
      <td>${escapeHtml(a.error || '')}</td>
    </tr>`;
  }).join('');
  els.resultsBody.innerHTML = rows || '<tr><td colspan="4">Пока нет результатов</td></tr>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function init() {
  const paths = await window.onboardPanel.getPaths();
  els.pathsInfo.textContent = `Папка: ${paths.baseDir}`;

  const config = await window.onboardPanel.loadConfig();
  fillConfigForm(config);

  els.accountsText.value = await window.onboardPanel.loadAccounts();
  await refreshResults();

  const running = await window.onboardPanel.isRunning();
  setStatus(running ? 'running' : 'idle');

  window.onboardPanel.onLog(appendLog);
  window.onboardPanel.onStatus(setStatus);

  setInterval(refreshResults, 5000);
}

els.btnSaveConfig.addEventListener('click', async () => {
  await window.onboardPanel.saveConfig(readConfigFromForm());
  appendLog('[Panel] onboard-config.json сохранён');
});

els.btnSaveAccounts.addEventListener('click', async () => {
  await window.onboardPanel.saveAccounts(els.accountsText.value);
  appendLog('[Panel] accounts.txt сохранён');
});

els.btnStart.addEventListener('click', async () => {
  try {
    await window.onboardPanel.saveConfig(readConfigFromForm());
    await window.onboardPanel.saveAccounts(els.accountsText.value);
    await window.onboardPanel.startOnboard();
    appendLog('[Panel] Онбординг запущен');
  } catch (err) {
    appendLog(`[Panel] Ошибка старта: ${err.message}`);
  }
});

els.btnStop.addEventListener('click', async () => {
  await window.onboardPanel.stopOnboard();
});

els.btnRefreshResults.addEventListener('click', refreshResults);
els.btnClearLog.addEventListener('click', () => { els.logBox.textContent = ''; });

init().catch((err) => appendLog(`[Panel] Init error: ${err.message}`));
