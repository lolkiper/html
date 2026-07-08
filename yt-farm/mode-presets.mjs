/**
 * Пресеты режимов YouTube Zaliver.
 * single — 1 видео за запуск, публикация сразу (без расписания)
 * multi  — пачка из 10 видео с отложенной публикацией по графику
 */

export const FARM_MODE_PRESETS = {
  single: {
    FARM_MODE: 'single',
    SCHEDULE_SETTINGS: {
      BATCH_SIZE: 1,
      VIDEOS_PER_CHANNEL: 50,
      USE_SCHEDULE: false,
      SCHEDULE_HOURS: [7, 13, 19, 1],
      LOW_SCHEDULE_THRESHOLD: 10,
      SCHEDULE_EXTENSION_BUFFER: 50,
    },
  },
  multi: {
    FARM_MODE: 'multi',
    SCHEDULE_SETTINGS: {
      BATCH_SIZE: 10,
      VIDEOS_PER_CHANNEL: 50,
      USE_SCHEDULE: true,
      SCHEDULE_HOURS: [7, 13, 19, 1],
      LOW_SCHEDULE_THRESHOLD: 10,
      SCHEDULE_EXTENSION_BUFFER: 50,
    },
  },
};

export const ANTIDETECT_PRESETS = {
  single: {
    BETWEEN_UPLOAD_MIN_MS: 5000,
    BETWEEN_UPLOAD_MAX_MS: 5000,
  },
  multi: {
    BETWEEN_UPLOAD_MIN_MS: 10000,
    BETWEEN_UPLOAD_MAX_MS: 12000,
  },
};

export function normalizeFarmMode(mode) {
  return mode === 'multi' ? 'multi' : 'single';
}

export function getModePreset(mode) {
  return FARM_MODE_PRESETS[normalizeFarmMode(mode)];
}

/**
 * Применяет пресет режима к конфигу (SCHEDULE_SETTINGS мержатся поверх существующих).
 */
export function applyFarmModePreset(config, mode) {
  const preset = getModePreset(mode);
  const farmMode = preset.FARM_MODE;

  const antidetect = ANTIDETECT_PRESETS[farmMode] || ANTIDETECT_PRESETS.single;

  return {
    ...config,
    FARM_MODE: farmMode,
    SCHEDULE_SETTINGS: {
      ...(config.SCHEDULE_SETTINGS || {}),
      ...preset.SCHEDULE_SETTINGS,
    },
    ANTIDETECT: {
      ...(config.ANTIDETECT || {}),
      ...antidetect,
    },
  };
}

export function isScheduleMode(config) {
  const mode = normalizeFarmMode(config?.FARM_MODE);
  if (mode === 'single') return false;
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
