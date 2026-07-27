/**
 * Пресеты режимов YouTube Zaliver (внутри panel/ — всегда в сборке).
 */

export const FARM_MODE_PRESETS = {
  single: {
    FARM_MODE: 'single',
    SCHEDULE_SETTINGS: {
      BATCH_SIZE: 1,
      VIDEOS_PER_CHANNEL: 10,
      USE_SCHEDULE: false,
      SCHEDULE_HOURS: [7, 13, 19, 1],
      LOW_SCHEDULE_THRESHOLD: 10,
      SCHEDULE_EXTENSION_BUFFER: 10,
    },
  },
  multi: {
    FARM_MODE: 'multi',
    SCHEDULE_SETTINGS: {
      BATCH_SIZE: 10,
      VIDEOS_PER_CHANNEL: 10,
      USE_SCHEDULE: true,
      SCHEDULE_HOURS: [7, 13, 19, 1],
      LOW_SCHEDULE_THRESHOLD: 10,
      SCHEDULE_EXTENSION_BUFFER: 10,
    },
  },
};

export const ANTIDETECT_PRESETS = {
  single: { BETWEEN_UPLOAD_MIN_MS: 5000, BETWEEN_UPLOAD_MAX_MS: 5000 },
  multi: { BETWEEN_UPLOAD_MIN_MS: 10000, BETWEEN_UPLOAD_MAX_MS: 12000 },
};

export function normalizeFarmMode(mode) {
  return mode === 'multi' ? 'multi' : 'single';
}

export function getModePreset(mode) {
  return FARM_MODE_PRESETS[normalizeFarmMode(mode)];
}

export function applyFarmModePreset(config, mode) {
  const preset = getModePreset(mode);
  const farmMode = preset.FARM_MODE;
  const antidetect = ANTIDETECT_PRESETS[farmMode] || ANTIDETECT_PRESETS.single;
  const userSchedule = config.SCHEDULE_SETTINGS || {};
  const videosPerChannel = getVideosPerChannel({
    ...config,
    SCHEDULE_SETTINGS: userSchedule,
  });
  return {
    ...config,
    FARM_MODE: farmMode,
    SCHEDULE_SETTINGS: {
      ...preset.SCHEDULE_SETTINGS,
      ...userSchedule,
      BATCH_SIZE: preset.SCHEDULE_SETTINGS.BATCH_SIZE,
      USE_SCHEDULE: preset.SCHEDULE_SETTINGS.USE_SCHEDULE,
      VIDEOS_PER_CHANNEL: videosPerChannel,
    },
    ANTIDETECT: { ...(config.ANTIDETECT || {}), ...antidetect },
  };
}

export function isScheduleMode(config) {
  if (normalizeFarmMode(config?.FARM_MODE) === 'single') return false;
  return config?.SCHEDULE_SETTINGS?.USE_SCHEDULE !== false;
}

export function getEffectiveBatchSize(config) {
  const preset = getModePreset(config?.FARM_MODE);
  return config?.SCHEDULE_SETTINGS?.BATCH_SIZE ?? preset.SCHEDULE_SETTINGS.BATCH_SIZE;
}

export function getVideosPerChannel(config) {
  const preset = getModePreset(config?.FARM_MODE);
  return config?.SCHEDULE_SETTINGS?.VIDEOS_PER_CHANNEL
    ?? config?.VIDEOS_PER_CHANNEL
    ?? preset.SCHEDULE_SETTINGS.VIDEOS_PER_CHANNEL;
}

/** Жёстко фиксирует лимит — пресет режима при START больше не перезапишет. */
export function pinVideosPerChannel(config, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return config;
  return {
    ...config,
    VIDEOS_PER_CHANNEL: n,
    SCHEDULE_SETTINGS: {
      ...(config.SCHEDULE_SETTINGS || {}),
      VIDEOS_PER_CHANNEL: n,
    },
  };
}
