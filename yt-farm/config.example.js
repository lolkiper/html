import dotenv from 'dotenv';

dotenv.config();

export const CONFIG = {
  DOLPHIN_API_URL: process.env.DOLPHIN_API_URL,
  DOLPHIN_TOKEN: process.env.DOLPHIN_TOKEN,

  VIDEOS_DIR: './videos',
  TOTAL_CHANNELS: 16,
  VIDEOS_PER_CHANNEL: 16,

  CONCURRENCY_LIMIT: 6,

  PROFILE_MAPPING: {
    dolphin_profile_id_1: [1],
    dolphin_profile_id_2: [2],
  },

  BASE_TITLES: [
    'Example title 1',
    'Example title 2',
  ],

  // Опционально — иначе дефолты в upload-farm.mjs
  SCHEDULE_SETTINGS: {
    BATCH_SIZE: 10,
    STEP_HOURS: 6,
    NEW_CHANNEL_START_HOUR: 7,
    LOW_SCHEDULE_THRESHOLD: 10,
  },

  ANTIDETECT: {
    BETWEEN_UPLOAD_MIN_MS: 1000,
    BETWEEN_UPLOAD_MAX_MS: 1000,
  },
};
