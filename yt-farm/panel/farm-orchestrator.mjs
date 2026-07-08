import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyFarmModePreset } from './mode-presets.mjs';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveMainScript(baseDir) {
  const candidates = [
    path.join(baseDir, 'main.mjs'),
    path.join(PANEL_DIR, '..', 'main.mjs'),
    path.join(process.resourcesPath || '', 'farm', 'main.mjs'),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    throw new Error(`main.mjs не найден. Положите main.mjs и youtube-studio.mjs в: ${baseDir}`);
  }
  return found;
}

export function getFarmPaths(baseDir = process.cwd()) {
  return {
    configPath: path.join(baseDir, 'config.json'),
    mainScript: resolveMainScript(baseDir),
    baseDir,
  };
}

export function loadConfig(baseDir) {
  const { configPath } = getFarmPaths(baseDir);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function saveConfig(baseDir, config) {
  const { configPath } = getFarmPaths(baseDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function mergeGuiConfig(baseDir, guiConfig) {
  const existing = loadConfig(baseDir) || {};
  const mode = guiConfig.FARM_MODE || existing.FARM_MODE || 'single';

  const merged = applyFarmModePreset({
    ...existing,
    ...guiConfig,
    PROFILE_MAPPING: guiConfig.PROFILE_MAPPING || existing.PROFILE_MAPPING || {},
    BASE_TITLES: guiConfig.BASE_TITLES || existing.BASE_TITLES || [],
    VIDEOS_DIR: guiConfig.VIDEOS_DIR || existing.VIDEOS_DIR,
    CONCURRENCY_LIMIT: guiConfig.CONCURRENCY_LIMIT ?? existing.CONCURRENCY_LIMIT ?? 6,
    MAX_PARALLEL_SLOTS: guiConfig.CONCURRENCY_LIMIT ?? existing.MAX_PARALLEL_SLOTS ?? existing.CONCURRENCY_LIMIT ?? 6,
    TOTAL_CHANNELS: guiConfig.TOTAL_CHANNELS ?? existing.TOTAL_CHANNELS,
  }, mode);

  return merged;
}

export function createFarmOrchestrator({ baseDir, onLog, onStatus }) {
  const { mainScript } = getFarmPaths(baseDir);
  const activeChildren = new Map();
  let stopped = false;
  let running = 0;
  let concurrency = 1;

  let slotPool = [];
  let nextJobIndex = 0;
  let jobs = [];

  function emit(threadNum, text, stats = null) {
    if (onLog) onLog({ threadNum, text, stats });
  }

  function releaseSlot(slot) {
    if (!slotPool.includes(slot)) slotPool.push(slot);
    slotPool.sort((a, b) => a - b);
  }

  function takeSlot() {
    return slotPool.shift();
  }

  function parseWorkerLine(slot, line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const json = JSON.parse(trimmed);
      if (json.DATA_TYPE === 'STATS_UPDATE') {
        emit(888, '', {
          channelNum: json.channelNum,
          profileId: json.profileId,
          subs: json.subs,
          views: json.views,
          uploaded: json.uploaded,
          status: json.status,
        });
        return;
      }
    } catch { /* not json */ }

    emit(slot, trimmed);
  }

  function spawnWorker(slot, profileId) {
    const env = { ...process.env };
    if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';

    const child = spawn(process.execPath, [mainScript, String(slot), profileId], {
      cwd: baseDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
    });

    activeChildren.set(slot, child);

    const handleChunk = (chunk) => {
      chunk.toString('utf-8').split('\n').forEach((line) => parseWorkerLine(slot, line));
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('close', () => {
      activeChildren.delete(slot);
      running = Math.max(0, running - 1);
      emit(slot, '💤 Слот свободен');
      releaseSlot(slot);
      pumpQueue();
    });

    child.on('error', (err) => {
      emit(slot, `❌ Ошибка процесса: ${err.message}`);
    });

    return child;
  }

  function pumpQueue() {
    if (stopped) return;
    while (running < concurrency && nextJobIndex < jobs.length && slotPool.length > 0) {
      const job = jobs[nextJobIndex++];
      const slot = takeSlot();
      running += 1;
      emit(slot, `🔄 Поток №${slot} взял в работу профиль ${job.profileId} (канал №${job.channelNum ?? '?'})`);
      spawnWorker(slot, job.profileId);
    }

    if (running === 0 && nextJobIndex >= jobs.length && activeChildren.size === 0) {
      if (onStatus) onStatus('idle');
      emit(999, '🏁 Все потоки завершили работу');
    }
  }

  return {
    start(config) {
      stopped = false;
      concurrency = Math.max(1, Number(config.CONCURRENCY_LIMIT ?? config.MAX_PARALLEL_SLOTS ?? 1));
      const mapping = config.PROFILE_MAPPING || {};
      const profileIds = Object.keys(mapping);

      if (!profileIds.length) {
        emit(999, '❌ Нет профилей Dolphin в таблице каналов');
        return false;
      }

      jobs = profileIds.map((profileId) => ({
        profileId,
        channelNum: mapping[profileId]?.[0],
      }));
      nextJobIndex = 0;
      slotPool = Array.from({ length: concurrency }, (_, i) => i + 1);

      const modeLabel = config.FARM_MODE === 'multi' ? 'МУЛЬТИ (10 видео + расписание)' : 'ОДИНАРНЫЙ (1 видео сразу)';
      emit(999, `🔮 Залив запущен в режиме [${modeLabel}] — каналов: ${profileIds.length}, потоков: ${concurrency}`);

      if (onStatus) onStatus('running');
      pumpQueue();
      return true;
    },

    stop() {
      stopped = true;
      jobs = [];
      nextJobIndex = 0;
      slotPool = [];
      for (const [slot, child] of activeChildren.entries()) {
        emit(slot, '🛑 Остановка потока...');
        child.kill('SIGTERM');
      }
      activeChildren.clear();
      running = 0;
      if (onStatus) onStatus('stopped');
      emit(999, '🛑 Работа фермы принудительно остановлена');
    },

    isRunning() {
      return running > 0 || nextJobIndex < jobs.length || activeChildren.size > 0;
    },
  };
}
