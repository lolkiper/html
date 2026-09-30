import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  assemblePlan,
  buildPublishPlanFromDisk,
  compareVideoNames,
  countMismatchMessage,
  formatPublishPreview,
  listVideoNames,
  readTitleLines,
} from './publish-plan.mjs';

const EXACT_TITLE = 'MI NOVIA ME ENGAÑÓ EN BROOKHAVEN 😱 #roblox #shorts';

test('названия сохраняются целиком, включая эмодзи и хэштеги', () => {
  const titles = readTitleLines(`${EXACT_TITLE}\nВторая строка  \n`);
  assert.equal(titles[0], EXACT_TITLE);
  assert.equal(titles[1], 'Вторая строка  ');
  assert.equal(titles.length, 2);
});

test('пустая строка внутри файла не сдвигает следующие названия', () => {
  const titles = readTitleLines('Название 1\n\nНазвание 3\n');
  assert.deepEqual(titles, ['Название 1', '', 'Название 3']);
});

test('видео сортируются естественно, а не побайтово', () => {
  const sorted = listVideoNames(['10.mp4', '2.mov', '1.mp4', 'nazvaniya.txt', 'notes.txt']);
  assert.deepEqual(sorted, ['1.mp4', '2.mov', '10.mp4']);
  assert.ok(compareVideoNames('part2.mov', 'part10.mov') < 0);
});

test('несовпадение количества останавливает публикацию до сборки очереди', () => {
  const channels = Array.from({ length: 10 }, (_, i) => ({ profileId: `p${i}`, channelNumber: i + 1 }));
  const videos = Array.from({ length: 10 }, (_, i) => `video${i + 1}.mp4`);
  const titles = Array.from({ length: 9 }, (_, i) => `Название ${i + 1}`);
  assert.throws(
    () => assemblePlan({ channels, videoNames: videos, titles }),
    (error) => error.code === 'COUNT_MISMATCH'
      && error.message === countMismatchMessage(10, 10, 9)
      && error.message === 'Ошибка: количество каналов (10), видео (10) и названий (9) не совпадает. Публикация остановлена.',
  );
});

test('индекс канала равен индексу видео и индексу названия', () => {
  const channels = [1, 2, 3, 4].map((n) => ({ profileId: `dolphin-${n}`, channelNumber: n }));
  const videoNames = ['video1.mp4', 'video2.mp4', 'video3.mp4', 'video4.mp4'];
  const titles = ['Название 1', EXACT_TITLE, 'Название 3', 'Название 4'];
  const items = assemblePlan({ channels, videoNames, titles });

  assert.equal(items.length, 4);
  items.forEach((item, index) => {
    assert.equal(item.index, index);
    assert.equal(item.channelNumber, index + 1);
    assert.equal(item.videoName, videoNames[index]);
    assert.equal(item.title, titles[index]);
  });
  assert.equal(items[1].title, EXACT_TITLE);
  assert.equal(formatPublishPreview(items[0], 4), [
    '[1/4]',
    'Канал: Канал 1',
    'Видео: video1.mp4',
    'Название: Название 1',
  ].join('\n'));
});

test('с диска читается тот же порядок и то же название', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-plan-'));
  fs.writeFileSync(path.join(root, '10.mp4'), '');
  fs.writeFileSync(path.join(root, '2.mp4'), '');
  fs.writeFileSync(path.join(root, '1.mp4'), '');
  fs.writeFileSync(path.join(root, 'nazvaniya.txt'), `${EXACT_TITLE}\nНазвание 2\nНазвание 3\n`, 'utf8');

  const plan = buildPublishPlanFromDisk({
    profileMapping: {
      'profile-b': [2],
      'profile-a': [1],
      'profile-c': [3],
    },
    videosDir: root,
    titlesFile: path.join(root, 'nazvaniya.txt'),
  });

  assert.deepEqual(plan.videoNames, ['1.mp4', '2.mp4', '10.mp4']);
  assert.equal(plan.items[0].profileId, 'profile-b');
  assert.equal(plan.items[0].videoName, '1.mp4');
  assert.equal(plan.items[0].title, EXACT_TITLE);
  assert.equal(plan.items[1].profileId, 'profile-a');
  assert.equal(plan.items[1].videoName, '2.mp4');
  assert.equal(plan.items[2].videoName, '10.mp4');
  assert.equal(plan.items[2].title, 'Название 3');
});

test('загрузчик больше не выбирает случайное название и не перемешивает очередь', () => {
  const main = fs.readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const uploadStart = main.indexOf('function indexedAssignment');
  const uploadEnd = main.lastIndexOf('await uploadVideo(page, videoToUpload');
  const selection = main.slice(uploadStart, uploadEnd);
  assert.equal(uploadStart > 0 && uploadEnd > uploadStart, true);
  assert.doesNotMatch(selection, /resolveTitleForUpload|shuffle\(|Shorts Video|BASE_TITLES|part\$\{/);
  assert.match(selection, /assignment\.title/);
  assert.equal(path.basename(fileURLToPath(import.meta.url)), 'publish-plan.test.mjs');
});
