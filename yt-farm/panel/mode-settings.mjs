const EMPTY_MODE_SETTINGS = {
  PROFILE_MAPPING: {},
  VIDEOS_DIR: '',
  CONCURRENCY_LIMIT: 6,
  BASE_TITLES: [],
};

export function normalizeMode(mode) {
  return mode === 'multi' ? 'multi' : 'single';
}

export function packModeSettings(config = {}) {
  return {
    PROFILE_MAPPING: config.PROFILE_MAPPING || {},
    VIDEOS_DIR: config.VIDEOS_DIR || '',
    CONCURRENCY_LIMIT: config.CONCURRENCY_LIMIT ?? 6,
    BASE_TITLES: config.BASE_TITLES || [],
  };
}

export function migrateModeSettings(config = {}) {
  if (config.MODE_SETTINGS?.single && config.MODE_SETTINGS?.multi) {
    return config;
  }

  const pack = packModeSettings(config);
  const active = normalizeMode(config.FARM_MODE);
  const shared = {
    VIDEOS_DIR: pack.VIDEOS_DIR,
    CONCURRENCY_LIMIT: pack.CONCURRENCY_LIMIT,
    BASE_TITLES: [...pack.BASE_TITLES],
  };

  return {
    ...config,
    MODE_SETTINGS: {
      single: active === 'single'
        ? { ...pack }
        : { ...EMPTY_MODE_SETTINGS, ...shared, PROFILE_MAPPING: {} },
      multi: active === 'multi'
        ? { ...pack }
        : { ...EMPTY_MODE_SETTINGS, ...shared, PROFILE_MAPPING: {} },
    },
  };
}

export function getModeSettings(config, mode) {
  const key = normalizeMode(mode);
  return config.MODE_SETTINGS?.[key] || { ...EMPTY_MODE_SETTINGS };
}

export function saveModeSnapshot(config, mode, snapshot = {}) {
  const migrated = migrateModeSettings(config);
  const key = normalizeMode(mode);

  migrated.MODE_SETTINGS[key] = {
    PROFILE_MAPPING: snapshot.PROFILE_MAPPING || {},
    VIDEOS_DIR: snapshot.VIDEOS_DIR ?? migrated.MODE_SETTINGS[key]?.VIDEOS_DIR ?? '',
    CONCURRENCY_LIMIT: snapshot.CONCURRENCY_LIMIT ?? migrated.MODE_SETTINGS[key]?.CONCURRENCY_LIMIT ?? 6,
    BASE_TITLES: snapshot.BASE_TITLES ?? migrated.MODE_SETTINGS[key]?.BASE_TITLES ?? [],
  };

  return migrated;
}

export function applyModeSettingsToConfig(config, mode) {
  const settings = getModeSettings(config, mode);
  return {
    ...config,
    FARM_MODE: normalizeMode(mode),
    PROFILE_MAPPING: settings.PROFILE_MAPPING || {},
    VIDEOS_DIR: settings.VIDEOS_DIR || config.VIDEOS_DIR || '',
    CONCURRENCY_LIMIT: settings.CONCURRENCY_LIMIT ?? config.CONCURRENCY_LIMIT ?? 6,
    MAX_PARALLEL_SLOTS: settings.CONCURRENCY_LIMIT ?? config.MAX_PARALLEL_SLOTS ?? config.CONCURRENCY_LIMIT ?? 6,
    BASE_TITLES: settings.BASE_TITLES?.length ? settings.BASE_TITLES : (config.BASE_TITLES || []),
  };
}
