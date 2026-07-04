import fs from 'fs';
import path from 'path';

const DEFAULTS = {
  STEP_HOURS: 6,
  NEW_CHANNEL_START_HOUR: 7,
  LOW_SCHEDULE_THRESHOLD: 10,
  VIDEOS_PER_CHANNEL: 16,
  SCHEDULE_EXTENSION_BUFFER: 16,
};

/**
 * Парсит "DD.MM.YYYY HH:MM" в локальный Date (GMT+3 задаётся на стороне YouTube Studio).
 */
export function parseScheduleTime(str) {
  const [datePart, timePart] = str.split(' ');
  const [day, month, year] = datePart.split('.').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

export function formatScheduleTime(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

export function addHours(date, hours) {
  const result = new Date(date.getTime());
  result.setHours(result.getHours() + hours);
  return result;
}

export function getTomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export function generateInitialSchedule(slotCount, settings = {}) {
  const stepHours = settings.STEP_HOURS ?? DEFAULTS.STEP_HOURS;
  const startHour = settings.NEW_CHANNEL_START_HOUR ?? DEFAULTS.NEW_CHANNEL_START_HOUR;
  const start = getTomorrowAt(startHour);
  const schedule = [];
  let current = new Date(start);

  for (let i = 0; i < slotCount; i++) {
    schedule.push(formatScheduleTime(current));
    current = addHours(current, stepHours);
  }

  return schedule;
}

export function extendSchedule(existingSchedule, slotsToAdd, settings = {}) {
  const stepHours = settings.STEP_HOURS ?? DEFAULTS.STEP_HOURS;

  if (!existingSchedule.length) {
    return generateInitialSchedule(slotsToAdd, settings);
  }

  const extended = [...existingSchedule];
  let last = parseScheduleTime(extended[extended.length - 1]);

  for (let i = 0; i < slotsToAdd; i++) {
    last = addHours(last, stepHours);
    extended.push(formatScheduleTime(last));
  }

  return extended;
}

function mergeSettings(configSettings = {}) {
  return { ...DEFAULTS, ...configSettings };
}

/**
 * Хранилище per-channel расписания в channel-state.json.
 * Ключ — номер канала (стабильный идентификатор пула видео partN.mov).
 */
export class ChannelStateStore {
  constructor(baseDir) {
    this.statePath = path.join(baseDir, 'channel-state.json');
  }

  load() {
    if (!fs.existsSync(this.statePath)) {
      return { version: 1, channels: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
    } catch {
      return { version: 1, channels: {} };
    }
  }

  save(state) {
    const tmpPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.statePath);
  }

  getChannelKey(channelNumber) {
    return String(channelNumber);
  }

  /**
   * Сканирует PROFILE_MAPPING и регистрирует новые каналы без расписания.
   */
  syncFromProfileMapping(profileMapping) {
    const state = this.load();
    let changed = false;
    const discovered = { new: [], existing: [] };

    for (const [profileId, channelData] of Object.entries(profileMapping || {})) {
      const channelNumber = channelData?.[0];
      if (!channelNumber) continue;

      const key = this.getChannelKey(channelNumber);

      if (!state.channels[key]) {
        state.channels[key] = {
          channelNumber,
          profileId,
          initialized: false,
          schedule: [],
          createdAt: new Date().toISOString(),
        };
        discovered.new.push({ channelNumber, profileId });
        changed = true;
      } else {
        discovered.existing.push({ channelNumber, profileId });
        if (state.channels[key].profileId !== profileId) {
          state.channels[key].profileId = profileId;
          changed = true;
        }
      }
    }

    if (changed) this.save(state);
    return { state, discovered };
  }

  getChannel(channelNumber) {
    const state = this.load();
    return state.channels[this.getChannelKey(channelNumber)] || null;
  }

  isChannelInitialized(channelNumber) {
    const channel = this.getChannel(channelNumber);
    return Boolean(channel?.initialized && channel.schedule?.length);
  }

  /**
   * Миграция: канал уже заливал видео, но state ещё не создан.
   * Восстанавливаем слоты из history + продлеваем вперёд при необходимости.
   */
  migrateFromHistory(channelNumber, history, settings) {
    const merged = mergeSettings(settings);
    const state = this.load();
    const key = this.getChannelKey(channelNumber);
    const channel = state.channels[key];
    if (!channel) return null;

    const uploads = (history.uploaded || [])
      .filter((item) => item.channel === channelNumber && item.scheduledFor)
      .sort((a, b) => parseScheduleTime(a.scheduledFor) - parseScheduleTime(b.scheduledFor));

    if (!uploads.length) return null;
    if (channel.initialized && channel.schedule.length) return channel.schedule;

    const schedule = uploads.map((u) => u.scheduledFor);
    const uploadedCount = uploads.length;
    const remaining = merged.VIDEOS_PER_CHANNEL - uploadedCount;

    if (remaining > 0) {
      const extra = Math.max(remaining, merged.LOW_SCHEDULE_THRESHOLD);
      channel.schedule = extendSchedule(schedule, extra, merged);
    } else {
      channel.schedule = schedule;
    }

    channel.initialized = true;
    channel.initializedAt = channel.initializedAt || new Date().toISOString();
    channel.migratedFromHistory = true;
    state.channels[key] = channel;
    this.save(state);

    console.log(
      `[Schedule] Канал №${channelNumber}: миграция из history (${uploadedCount} слотов, всего ${channel.schedule.length})`
    );
    return channel.schedule;
  }

  /**
   * Одноразовая миграция со старого глобального CONFIG.SCHEDULE (канал без history).
   */
  migrateFromLegacyConfigSchedule(channelNumber, legacySchedule, settings) {
    if (!legacySchedule?.length) return null;

    const state = this.load();
    const key = this.getChannelKey(channelNumber);
    const channel = state.channels[key];
    if (!channel || channel.initialized) return channel?.schedule || null;

    channel.schedule = [...legacySchedule];
    channel.initialized = true;
    channel.initializedAt = new Date().toISOString();
    channel.migratedFromLegacyConfig = true;
    state.channels[key] = channel;
    this.save(state);

    console.log(
      `[Schedule] Канал №${channelNumber}: миграция из CONFIG.SCHEDULE (${legacySchedule.length} слотов)`
    );
    return channel.schedule;
  }

  /**
   * Первый запуск нового канала: завтра 07:00, шаг 6ч.
   */
  initializeChannel(channelNumber, settings) {
    const merged = mergeSettings(settings);
    const state = this.load();
    const key = this.getChannelKey(channelNumber);
    const channel = state.channels[key];

    if (!channel) {
      throw new Error(`Канал №${channelNumber} не найден в channel-state.json`);
    }

    if (channel.initialized && channel.schedule.length) {
      return channel.schedule;
    }

    channel.schedule = generateInitialSchedule(merged.VIDEOS_PER_CHANNEL, merged);
    channel.initialized = true;
    channel.initializedAt = new Date().toISOString();
    state.channels[key] = channel;
    this.save(state);

    console.log(
      `[Schedule] Канал №${channelNumber}: новое расписание с ${channel.schedule[0]} (${channel.schedule.length} слотов, шаг ${merged.STEP_HOURS}ч)`
    );
    return channel.schedule;
  }

  /**
   * Если осталось < threshold свободных слотов — дописывает в конец от последней даты.
   */
  ensureScheduleCapacity(channelNumber, uploadedCount, settings) {
    const merged = mergeSettings(settings);
    const state = this.load();
    const key = this.getChannelKey(channelNumber);
    const channel = state.channels[key];

    if (!channel?.initialized) {
      return this.initializeChannel(channelNumber, merged);
    }

    const remainingSlots = channel.schedule.length - uploadedCount;

    if (remainingSlots < merged.LOW_SCHEDULE_THRESHOLD) {
      const videosStillNeeded = Math.max(0, merged.VIDEOS_PER_CHANNEL - uploadedCount);
      const targetRemaining = Math.max(
        videosStillNeeded,
        merged.LOW_SCHEDULE_THRESHOLD,
        merged.SCHEDULE_EXTENSION_BUFFER
      );
      const slotsToAdd = targetRemaining - remainingSlots;

      if (slotsToAdd > 0) {
        const before = channel.schedule.length;
        const lastSlot = channel.schedule[channel.schedule.length - 1];
        channel.schedule = extendSchedule(channel.schedule, slotsToAdd, merged);
        channel.lastExtendedAt = new Date().toISOString();
        state.channels[key] = channel;
        this.save(state);
        console.log(
          `[Schedule] Канал №${channelNumber}: продлено ${before} → ${channel.schedule.length} (последний был ${lastSlot}, новый ${channel.schedule[channel.schedule.length - 1]})`
        );
      }
    }

    return channel.schedule;
  }

  getBatchSlots(channelNumber, uploadedCount, batchSize) {
    const channel = this.getChannel(channelNumber);
    if (!channel?.schedule?.length) return [];
    return channel.schedule.slice(uploadedCount, uploadedCount + batchSize);
  }

  /**
   * Полный пайплайн подготовки расписания для одного канала перед заливкой.
   */
  prepareChannelSchedule({
    channelNumber,
    profileId,
    history,
    settings,
    legacySchedule,
  }) {
    const merged = mergeSettings(settings);
    this.syncFromProfileMapping({ [profileId]: [channelNumber] });

    let schedule =
      this.migrateFromHistory(channelNumber, history, merged) ||
      this.migrateFromLegacyConfigSchedule(channelNumber, legacySchedule, merged);

    if (!schedule) {
      if (this.isChannelInitialized(channelNumber)) {
        schedule = this.getChannel(channelNumber).schedule;
      } else {
        schedule = this.initializeChannel(channelNumber, merged);
      }
    }

    const uploadedCount = (history.uploaded || []).filter((item) => item.channel === channelNumber).length;
    schedule = this.ensureScheduleCapacity(channelNumber, uploadedCount, merged);

    return {
      schedule,
      uploadedCount,
      batchSlots: (batchSize) => this.getBatchSlots(channelNumber, uploadedCount, batchSize),
    };
  }
}
