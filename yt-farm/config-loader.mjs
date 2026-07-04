import { CONFIG as RAW } from './config.js';

/**
 * Нормализует config.js под upload-farm / orchestrator.
 * Поддерживает поля из старого конфига: CONCURRENCY_LIMIT, VIDEOS_PER_CHANNEL в корне.
 */
export function loadAppConfig() {
  const schedule = RAW.SCHEDULE_SETTINGS || {};

  return {
    ...RAW,
    MAX_PARALLEL_SLOTS: RAW.MAX_PARALLEL_SLOTS ?? RAW.CONCURRENCY_LIMIT ?? 1,
    SCHEDULE_SETTINGS: {
      ...schedule,
      VIDEOS_PER_CHANNEL: schedule.VIDEOS_PER_CHANNEL ?? RAW.VIDEOS_PER_CHANNEL ?? 16,
    },
    ANTIDETECT: RAW.ANTIDETECT || {},
  };
}

export const CONFIG = loadAppConfig();
