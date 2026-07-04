import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG as RAW_CONFIG } from './config.js';

function normalizeConfig(raw) {
  const schedule = raw.SCHEDULE_SETTINGS || {};
  return {
    ...raw,
    MAX_PARALLEL_SLOTS: raw.MAX_PARALLEL_SLOTS ?? raw.CONCURRENCY_LIMIT ?? 1,
    SCHEDULE_SETTINGS: {
      ...schedule,
      VIDEOS_PER_CHANNEL: schedule.VIDEOS_PER_CHANNEL ?? raw.VIDEOS_PER_CHANNEL ?? 16,
    },
    ANTIDETECT: raw.ANTIDETECT || {},
  };
}

const CONFIG = normalizeConfig(RAW_CONFIG);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = process.cwd();
const MAX_PARALLEL = CONFIG.MAX_PARALLEL_SLOTS;
const farmScript = path.join(__dirname, 'upload-farm.mjs');

function runChannel(slot, profileId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [farmScript, String(slot), profileId], {
      cwd: baseDir,
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function runPool(items, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

async function main() {
  const mapping = CONFIG.PROFILE_MAPPING || {};
  const profileIds = Object.keys(mapping);

  if (!profileIds.length) {
    console.log('⚠️ PROFILE_MAPPING пуст — нечего обрабатывать.');
    return;
  }

  console.log(`\n🔄 Оркестратор: ${profileIds.length} каналов, параллельность: ${MAX_PARALLEL}`);

  const exitCodes = await runPool(profileIds, async (profileId, idx) => {
    const channelNum = mapping[profileId]?.[0] ?? '?';
    console.log(`\n▶️ Старт канала №${channelNum} (profile ${profileId}, слот ${idx + 1})`);
    return runChannel(idx + 1, profileId);
  });

  const failed = exitCodes.filter((code) => code !== 0).length;
  console.log(`\n🏁 Оркестратор завершён. Успешно: ${exitCodes.length - failed}, с ошибкой: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
