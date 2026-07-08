import dotenv from 'dotenv';

dotenv.config();

export const CONFIG = {
  DOLPHIN_API_URL: process.env.DOLPHIN_API_URL,
  DOLPHIN_TOKEN: process.env.DOLPHIN_TOKEN,

  VIDEOS_DIR: './videos',
  FARM_MODE: 'single',
  TOTAL_CHANNELS: 16,
  VIDEOS_PER_CHANNEL: 50,

  CONCURRENCY_LIMIT: 6,

  PROFILE_MAPPING: {
    dolphin_profile_id_1: [1],
    dolphin_profile_id_2: [2],
  },

  BASE_TITLES: [
    'Example title 1',
    'Example title 2',
  ],

  // Пресеты режимов: single = 1 видео сразу, multi = 10 видео + расписание
  SCHEDULE_SETTINGS: {
    BATCH_SIZE: 1,
    VIDEOS_PER_CHANNEL: 50,
    USE_SCHEDULE: false,
    SCHEDULE_HOURS: [7, 13, 19, 1],
    LOW_SCHEDULE_THRESHOLD: 10,
  },

  ANTIDETECT: {
    BETWEEN_UPLOAD_MIN_MS: 5000,
    BETWEEN_UPLOAD_MAX_MS: 5000,
  },
};
