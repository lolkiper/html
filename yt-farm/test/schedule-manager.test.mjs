import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ChannelStateStore,
  formatScheduleTime,
  generateInitialSchedule,
  parseScheduleTime,
  extendSchedule,
} from '../schedule-manager.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-farm-test-'));

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  const store = new ChannelStateStore(tmpDir);

  // Новый канал получает расписание с завтра 07:00, шаг 6ч
  store.syncFromProfileMapping({ profileA: [1] });
  const schedule = store.initializeChannel(1, { VIDEOS_PER_CHANNEL: 4, STEP_HOURS: 6, NEW_CHANNEL_START_HOUR: 7 });
  assert.strictEqual(schedule.length, 4);

  const t0 = parseScheduleTime(schedule[0]);
  const t1 = parseScheduleTime(schedule[1]);
  assert.strictEqual(t0.getHours(), 7);
  assert.strictEqual((t1 - t0) / 3600000, 6);

  // Продление от последнего слота
  const extended = extendSchedule(schedule, 2, { STEP_HOURS: 6 });
  assert.strictEqual(extended.length, 6);
  const last = parseScheduleTime(extended[extended.length - 1]);
  const prev = parseScheduleTime(extended[extended.length - 2]);
  assert.strictEqual((last - prev) / 3600000, 6);

  // ensureScheduleCapacity дописывает слоты при нехватке
  store.ensureScheduleCapacity(1, 2, { LOW_SCHEDULE_THRESHOLD: 10, VIDEOS_PER_CHANNEL: 16, STEP_HOURS: 6 });
  const after = store.getChannel(1);
  assert.ok(after.schedule.length >= 12);

  // Миграция из history
  const store2 = new ChannelStateStore(path.join(tmpDir, 'sub'));
  fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
  store2.syncFromProfileMapping({ profileB: [2] });
  const history = {
    uploaded: [
      { file: 'part17.mov', channel: 2, scheduledFor: '05.07.2026 07:00' },
      { file: 'part18.mov', channel: 2, scheduledFor: '05.07.2026 13:00' },
    ],
  };
  const migrated = store2.migrateFromHistory(2, history, { VIDEOS_PER_CHANNEL: 4, LOW_SCHEDULE_THRESHOLD: 2 });
  assert.ok(migrated.length >= 4);
  assert.strictEqual(migrated[0], '05.07.2026 07:00');
  assert.strictEqual(migrated[1], '05.07.2026 13:00');

  // Независимые расписания: разные каналы — разные записи в state
  store.syncFromProfileMapping({ profileC: [3] });
  const s3 = store.initializeChannel(3, { VIDEOS_PER_CHANNEL: 2 });
  const ch1 = store.getChannel(1);
  const ch3 = store.getChannel(3);
  assert.notStrictEqual(ch1.channelNumber, ch3.channelNumber);
  assert.ok(ch1.schedule.length > s3.length);

  console.log('✅ schedule-manager tests passed');
} finally {
  cleanup();
}
