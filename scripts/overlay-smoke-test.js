#!/usr/bin/env node
/**
 * Реальные рендеры Overlay (стоп-кадр + вставка поверх) и Shorts ON/OFF.
 *
 * Тестовые ролики кодируют номер кадра цветом (Y/U), а "владельца" кадра — Cr:
 * main 200, overlay 60, shorts 100. Звук: main — шум до 900 Гц, overlay — 3 кГц,
 * shorts — 5 кГц. По выходу восстанавливается последовательность кадров и звука
 * и сверяется с ожидаемой MAIN → OVERLAY → MAIN кадр в кадр.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const processor = require('../processor');

const FF = processor.ffmpegPath;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-smoke-'));
const MEDIA = path.join(ROOT, 'media');
fs.mkdirSync(MEDIA);

let failures = 0;
let passed = 0;
function check(cond, message) {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
  return cond;
}

function ff(args) {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

const lumExpr = (n) => `16+mod(${n},50)*4`;
const cbExpr = (n) => `16+mod(floor((${n})/50),14)*16`;
function colorVideo({ w, h, fps, d, cr, n = 'N' }) {
  return `color=c=black:s=${w}x${h}:r=${fps}:d=${d},format=yuv444p,` +
    `geq=lum='${lumExpr(n)}':cb='${cbExpr(n)}':cr=${cr}`;
}

function makeMain(file, { w, h, fps, d, audio }) {
  const args = ['-f', 'lavfi', '-i', colorVideo({ w, h, fps, d, cr: 200 })];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=white:r=${audio.rate}:a=0.5:seed=7,lowpass=f=900`);
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', String(fps));
  if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', String(audio.channels), '-ar', String(audio.rate));
  args.push('-t', String(d), file);
  ff(args);
}

function makeTone(file, { w, h, fps, d, cr, tone, rate = 48000, channels = 2 }) {
  const args = ['-f', 'lavfi', '-i', colorVideo({ w, h, fps, d, cr })];
  if (tone) args.push('-f', 'lavfi', '-i', `sine=f=${tone}:r=${rate}:d=${d}`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', String(fps));
  if (tone) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', String(channels), '-ar', String(rate));
  args.push('-t', String(d), file);
  ff(args);
}

function makeVfr(file) {
  // 3 с по 30 fps, затем 3 с по 60 fps; индекс = время в 1/30 с.
  ff([
    '-f', 'lavfi', '-i', colorVideo({ w: 640, h: 360, fps: 30, d: 3, cr: 200 }),
    '-f', 'lavfi', '-i', colorVideo({ w: 640, h: 360, fps: 60, d: 3, cr: 200, n: '90+floor(N/2)' }),
    '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=white:r=48000:a=0.5:seed=7,lowpass=f=900',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-t', '6', file
  ]);
}

const M = {
  main30: path.join(MEDIA, 'main30_mono44k.mp4'),
  main25: path.join(MEDIA, 'main25_noaudio.mp4'),
  main24s: path.join(MEDIA, 'main24_stereo48k.mp4'),
  vfr: path.join(MEDIA, 'main_vfr.mp4'),
  truncated: path.join(MEDIA, 'main_truncated.mp4'),
  broken: path.join(MEDIA, 'main_broken.mp4'),
  ov2s: path.join(MEDIA, 'ov2s_25fps_vertical.mp4'),
  ov1s: path.join(MEDIA, 'ov1s_60fps_noaudio.mp4'),
  ov30s: path.join(MEDIA, 'ov30s_mono22k.mp4'),
  shorts: path.join(MEDIA, 'shorts3s.mp4'),
  shortsQuiet: path.join(MEDIA, 'shorts3s_noaudio.mp4')
};

function makeMedia() {
  makeMain(M.main30, { w: 640, h: 360, fps: 30, d: 10, audio: { rate: 44100, channels: 1 } });
  makeMain(M.main25, { w: 480, h: 270, fps: 25, d: 8, audio: null });
  makeMain(M.main24s, { w: 854, h: 480, fps: 24, d: 6, audio: { rate: 48000, channels: 2 } });
  makeVfr(M.vfr);
  makeTone(M.ov2s, { w: 360, h: 640, fps: 25, d: 2, cr: 60, tone: 3000 });
  makeTone(M.ov1s, { w: 320, h: 240, fps: 60, d: 1, cr: 60, tone: null });
  makeTone(M.ov30s, { w: 400, h: 300, fps: 30, d: 30, cr: 60, tone: 3000, rate: 22050, channels: 1 });
  makeTone(M.shorts, { w: 360, h: 640, fps: 30, d: 3, cr: 100, tone: 5000 });
  makeTone(M.shortsQuiet, { w: 360, h: 640, fps: 30, d: 3, cr: 100, tone: null });
  // Обрезанный mp4 с moov в начале: заголовок читается, данных на середину не хватает.
  const full = path.join(MEDIA, 'full_faststart.mp4');
  ff(['-i', M.main30, '-c', 'copy', '-movflags', '+faststart', full]);
  const bytes = fs.readFileSync(full);
  fs.writeFileSync(M.truncated, bytes.subarray(0, Math.floor(bytes.length * 0.45)));
  fs.writeFileSync(M.broken, Buffer.alloc(4096, 7));
}

// ---------------------------------------------------------------------------
// Анализ результата
// ---------------------------------------------------------------------------

function probeStreams(file) {
  const text = execFileSync(processor.ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration,sample_rate,channels:format=duration',
    '-of', 'json', file
  ]).toString();
  const json = JSON.parse(text);
  const video = json.streams.find((s) => s.codec_type === 'video');
  const audio = json.streams.find((s) => s.codec_type === 'audio');
  return {
    format: Number(json.format.duration),
    video: video ? Number(video.duration) : NaN,
    audio: audio ? Number(audio.duration) : NaN,
    sampleRate: audio ? Number(audio.sample_rate) : 0,
    channels: audio ? Number(audio.channels) : 0
  };
}

const GW = 64;
const GH = 36;
function decodeFrames(file) {
  const raw = execFileSync(FF, [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `scale=${GW}:${GH}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'yuv444p', '-'
  ], { maxBuffer: 1 << 30 });
  const plane = GW * GH;
  const frames = [];
  for (let off = 0; off + plane * 3 <= raw.length; off += plane * 3) {
    const px = (x, y) => ({
      y: raw[off + y * GW + x],
      u: raw[off + plane + y * GW + x],
      v: raw[off + plane * 2 + y * GW + x]
    });
    frames.push({ corner: px(2, 2), center: px(GW / 2, GH / 2) });
  }
  return frames;
}

function owner(p) {
  if (Math.abs(p.v - 200) < 25) return 'M';
  if (Math.abs(p.v - 60) < 25) return 'O';
  if (Math.abs(p.v - 100) < 14) return 'S';
  if (Math.abs(p.v - 128) < 8 && p.y < 30) return 'K';
  return '?';
}

function index(p) {
  return Math.round((p.u - 16) / 16) * 50 + Math.round((p.y - 16) / 4);
}

function decodeAudio(file, seconds = null) {
  const args = ['-v', 'error', '-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', '48000'];
  if (seconds) args.push('-t', String(seconds));
  args.push('-f', 'f32le', '-');
  const raw = execFileSync(FF, args, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

const RATE = 48000;
const WIN = 0.02;
function classifyAudio(samples) {
  const size = Math.round(RATE * WIN);
  const out = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let rms = 0;
    let zc = 0;
    for (let j = i; j < i + size; j += 1) {
      rms += samples[j] * samples[j];
      if (j > i && (samples[j] >= 0) !== (samples[j - 1] >= 0)) zc += 1;
    }
    rms = Math.sqrt(rms / size);
    const rate = zc / WIN;
    let kind = '?';
    if (rms < 0.003) kind = '_';
    else if (rate < 3000) kind = 'M';
    else if (rate > 4500 && rate < 7500) kind = 'O';
    else if (rate > 8500 && rate < 11500) kind = 'S';
    out.push(kind);
  }
  return out;
}

function correlationLag(out, outStart, src, srcStart, length, search) {
  const n = Math.round(length * RATE);
  const a0 = Math.round(outStart * RATE);
  const b0 = Math.round(srcStart * RATE);
  const maxLag = Math.round(search * RATE);
  let best = { lag: 0, corr: -1 };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let k = 0; k < n; k += 1) {
      const a = out[a0 + k];
      const b = src[b0 + lag + k];
      if (a === undefined || b === undefined) return best;
      sab += a * b;
      saa += a * a;
      sbb += b * b;
    }
    const corr = sab / Math.sqrt(saa * sbb || 1);
    if (corr > best.corr) best = { lag: lag / RATE, corr };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ожидаемая последовательность
// ---------------------------------------------------------------------------

/**
 * Кадры выхода: ['M', i] — кадр i исходника; ['F', i, j] — стоп-кадр i и кадр j
 * overlay; ['S', j] — кадр Shorts. Блоки звука в секундах.
 */
function expectedTimeline({ mainFrames, fps, splitFrame, shortsFrames, freezeFrame, freezeFrames }) {
  const frames = [];
  const blocks = [];
  const pushBlock = (kind, len, srcStart) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind === 'M' && last.srcStart + last.len === srcStart) last.len += len;
    else blocks.push({ kind, len, srcStart });
  };
  for (let i = 0; i < mainFrames; i += 1) {
    if (splitFrame != null && i === splitFrame) {
      for (let j = 0; j < shortsFrames; j += 1) frames.push(['S', j]);
      pushBlock('S', shortsFrames);
    }
    if (freezeFrame != null && i === freezeFrame) {
      for (let j = 0; j < freezeFrames; j += 1) frames.push(['F', i, j]);
      pushBlock('F', freezeFrames);
    }
    frames.push(['M', i]);
    pushBlock('M', 1, i);
  }
  if (freezeFrame != null && freezeFrame >= mainFrames) {
    for (let j = 0; j < freezeFrames; j += 1) frames.push(['F', mainFrames - 1, j]);
    pushBlock('F', freezeFrames);
  }
  let t = 0;
  blocks.forEach((block) => {
    block.start = t / fps;
    block.duration = block.len / fps;
    if (block.kind === 'M') block.srcStart /= fps;
    t += block.len;
  });
  return { frames, blocks, duration: t / fps };
}

function verifyFrames(frames, expected, { exact = true, label }) {
  const want = expected.frames;
  check(Math.abs(frames.length - want.length) <= 1, `${label}: кадров ${frames.length}, ожидали ${want.length}`);
  const n = Math.min(frames.length, want.length);
  let bad = 0;
  let firstBad = null;
  let lastMain = -1;
  for (let k = 0; k < n; k += 1) {
    const [kind, a] = want[k];
    const f = frames[k];
    const cornerOwner = owner(f.corner);
    const centerOwner = owner(f.center);
    let ok = true;
    if (kind === 'M') {
      ok = cornerOwner === 'M' && centerOwner === 'M';
      const idx = index(f.corner) % 700;
      if (exact) ok = ok && idx === a % 700;
      else ok = ok && idx >= lastMain;
      if (ok) lastMain = idx;
    } else if (kind === 'F') {
      ok = cornerOwner === 'M' && centerOwner === 'O';
      if (exact) ok = ok && index(f.corner) % 700 === a % 700;
    } else if (kind === 'S') {
      ok = centerOwner === 'S' && cornerOwner === 'K';
    }
    if (!ok) {
      bad += 1;
      if (!firstBad) firstBad = { k, want: want[k], corner: f.corner, center: f.center, cornerOwner, centerOwner };
    }
  }
  check(bad === 0, `${label}: ${bad} кадров не совпало; первый: ${JSON.stringify(firstBad)}`);

  // Overlay во время паузы идёт вперёд, без возвратов.
  let prev = -1;
  let backwards = 0;
  for (let k = 0; k < n; k += 1) {
    if (want[k][0] === 'F') {
      const j = index(frames[k].center);
      if (want[k][2] === 0) prev = -1;
      if (j < prev && prev - j < 600) backwards += 1;
      prev = j;
    }
  }
  check(backwards === 0, `${label}: overlay прыгал назад ${backwards} раз`);
}

function verifyAudio(file, expected, { mainSource, mainHasAudio, overlayHasAudio, shortsHasAudio, label }) {
  const out = decodeAudio(file);
  const kinds = classifyAudio(out);
  const guard = 0.05;
  let wrong = 0;
  let first = null;
  expected.blocks.forEach((block) => {
    let want = block.kind;
    if (block.kind === 'M' && !mainHasAudio) want = '_';
    if (block.kind === 'F') want = overlayHasAudio ? 'O' : '_';
    if (block.kind === 'S') want = shortsHasAudio ? 'S' : '_';
    const from = Math.ceil((block.start + guard) / WIN);
    const to = Math.floor((block.start + block.duration - guard) / WIN);
    for (let w = from; w < to; w += 1) {
      if (kinds[w] !== want) {
        wrong += 1;
        if (!first) first = { t: (w * WIN).toFixed(2), want, got: kinds[w] };
      }
    }
  });
  check(wrong === 0, `${label}: звук не по порядку в ${wrong} окнах по 20 мс; первое: ${JSON.stringify(first)}`);

  const lastBlock = expected.blocks[expected.blocks.length - 1];
  const tail = kinds.slice(Math.ceil((lastBlock.start + lastBlock.duration + 0.05) / WIN));
  check(tail.every((k) => k === '_'), `${label}: после конца есть лишний звук`);

  if (!mainHasAudio || !mainSource) return;
  const src = decodeAudio(mainSource);
  expected.blocks.filter((b) => b.kind === 'M' && b.duration > 0.5).forEach((block) => {
    [0.15, block.duration - 0.35].forEach((offset) => {
      const res = correlationLag(out, block.start + offset, src, block.srcStart + offset, 0.2, 0.03);
      check(
        res.corr > 0.9 && Math.abs(res.lag) <= 0.0021,
        `${label}: main-звук на ${(block.start + offset).toFixed(2)}с сдвинут на ${(res.lag * 1000).toFixed(1)} мс (corr ${res.corr.toFixed(3)})`
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

function childFfmpegCount() {
  try {
    const text = execFileSync('ps', ['-o', 'comm=', '--ppid', String(process.pid)]).toString();
    return text.split('\n').filter((line) => /ffmpeg/.test(line)).length;
  } catch (err) {
    return 0;
  }
}

async function runBatch(name, files, settings, hooks = {}) {
  const dir = path.join(ROOT, name);
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  fs.mkdirSync(src, { recursive: true });
  files.forEach((file, i) => fs.copyFileSync(file, path.join(src, `${String(i + 1).padStart(2, '0')}_${path.basename(file)}`)));
  const logs = [];
  const progress = [];
  const batch = new processor.BatchProcessor({
    sourceDir: src,
    outputDir: out,
    shortsFile: M.shorts,
    percent: 50,
    encoder: 'h264',
    frame: 'source',
    fit: 'contain',
    resourceUsage: 'max',
    parallelJobs: 1,
    freezeSize: 70,
    ...settings
  }, {
    onLog: (level, message) => {
      logs.push({ level, message });
      if (hooks.onLog) hooks.onLog(level, message, src);
    },
    onProgress: (state) => progress.push(state)
  });
  const summary = await batch.run();
  return { summary, logs, progress, out, src };
}

function verifyProgress(progress, label) {
  const files = new Map();
  let over = 0;
  progress.forEach((p) => {
    if (p.filePercent > 100 || p.overallPercent > 100.0001) over += 1;
  });
  check(over === 0, `${label}: прогресс больше 100%`);
  const overall = progress.map((p) => p.overallPercent).filter(Number.isFinite);
  let back = 0;
  for (let i = 1; i < overall.length; i += 1) if (overall[i] + 1e-6 < overall[i - 1]) back += 1;
  check(back === 0, `${label}: общий прогресс шёл назад ${back} раз`);
  check(overall.length && Math.abs(overall[overall.length - 1] - 100) < 0.01, `${label}: общий прогресс не дошёл до 100%`);
  return files;
}

function verifyDurations(file, expectedSeconds, label, { audio = true } = {}) {
  const info = probeStreams(file);
  const tol = 0.07;
  check(Math.abs(info.format - expectedSeconds) < tol, `${label}: длительность файла ${info.format} вместо ${expectedSeconds.toFixed(3)}`);
  check(Math.abs(info.video - expectedSeconds) < tol, `${label}: видеопоток ${info.video} вместо ${expectedSeconds.toFixed(3)}`);
  if (audio) {
    check(Math.abs(info.audio - expectedSeconds) < tol, `${label}: аудиопоток ${info.audio} вместо ${expectedSeconds.toFixed(3)}`);
    check(info.sampleRate === 48000 && info.channels === 2, `${label}: звук ${info.sampleRate} Гц / ${info.channels} кан.`);
  }
  return info;
}

const MEDIA_INFO = {};
async function info(file) {
  if (!MEDIA_INFO[file]) MEDIA_INFO[file] = await processor.probeMedia(file);
  return MEDIA_INFO[file];
}

/**
 * Один сценарий с одним исходником. Ожидаемый план считается независимо:
 * кадровая сетка = fps исходника, T и длина overlay — целыми кадрами.
 */
async function scenario(label, {
  main, shorts = null, percent = 50, overlay = null, at = 0, freezePercent = null, exact = true, size = 70
}) {
  const t0 = Date.now();
  const failuresBefore = failures;
  const mainInfo = await info(main);
  const fps = processor.chooseOutputFps(mainInfo.fps);
  const settings = {
    useShorts: Boolean(shorts),
    shortsFile: shorts || '',
    percent,
    useFreeze: Boolean(overlay),
    freezeFile: overlay || '',
    freezeSize: size
  };
  if (freezePercent != null) {
    settings.freezePercent = freezePercent;
    at = (mainInfo.duration * freezePercent) / 100;
  } else {
    settings.freezeAt = at;
  }
  const run = await runBatch(label.replace(/[^a-z0-9]+/gi, '_'), [main], settings);
  const ok = check(run.summary.done === 1 && run.summary.failed === 0,
    `${label}: рендер не прошёл: ${run.logs.filter((l) => l.level === 'error').map((l) => l.message).join(' | ').slice(0, 800)}`);
  if (!ok) return;
  const outFile = fs.readdirSync(run.out).filter((f) => /^es\d+\.mp4$/.test(f)).map((f) => path.join(run.out, f))[0];

  const mainFrames = Math.round(mainInfo.duration * fps);
  let splitFrame = null;
  let shortsFrames = 0;
  let shortsInfo = null;
  if (shorts) {
    shortsInfo = await info(shorts);
    splitFrame = Math.round(processor.resolveSplitAt(mainInfo, percent) * fps);
    shortsFrames = Math.round(shortsInfo.duration * fps);
  }
  let freezeFrame = null;
  let freezeFrames = 0;
  let overlayInfo = null;
  if (overlay) {
    overlayInfo = await info(overlay);
    freezeFrame = Math.round(Math.min(at, mainInfo.duration) * fps);
    if (freezeFrame / fps > mainInfo.duration - 1 / fps + 1e-9) freezeFrame = mainFrames;
    freezeFrames = Math.max(1, Math.round(overlayInfo.duration * fps));
    const logged = run.logs.find((l) => /Overlay: стоп-кадр/.test(l.message));
    check(logged && new RegExp(`кадр ${freezeFrame} при`).test(logged.message),
      `${label}: в логе нет кадра стоп-кадра: ${logged && logged.message}`);
  }
  const expected = expectedTimeline({ mainFrames, fps, splitFrame, shortsFrames, freezeFrame, freezeFrames });

  verifyDurations(outFile, mainInfo.duration + (shortsInfo ? shortsInfo.duration : 0) + freezeFrames / fps, label);
  verifyFrames(decodeFrames(outFile), expected, { exact, label });
  verifyAudio(outFile, expected, {
    label,
    mainSource: main,
    mainHasAudio: mainInfo.hasAudio,
    overlayHasAudio: Boolean(overlayInfo && overlayInfo.hasAudio),
    shortsHasAudio: Boolean(shortsInfo && shortsInfo.hasAudio)
  });
  verifyProgress(run.progress, label);
  check(childFfmpegCount() === 0, `${label}: остались процессы ffmpeg`);
  if (failures !== failuresBefore) return;
  passed += 1;
  console.log(`ok ${label} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
}

async function main() {
  console.log(`FFmpeg: ${FF}\nПапка теста: ${ROOT}`);
  makeMedia();

  const list = [
    ['01 Overlay OFF, Shorts OFF (старый путь без вставок)', { main: M.main30 }],
    ['02 Shorts ON 50% (старый путь)', { main: M.main30, shorts: M.shorts, percent: 50 }],
    ['03 Shorts ON 90%', { main: M.main30, shorts: M.shorts, percent: 90 }],
    ['04 Shorts ON 60%, Shorts без звука', { main: M.main30, shorts: M.shortsQuiet, percent: 60 }],
    ['05 Overlay в начале (T=0)', { main: M.main30, overlay: M.ov2s, at: 0 }],
    ['06 Overlay в середине (T=4.5)', { main: M.main30, overlay: M.ov2s, at: 4.5 }],
    ['07 Overlay у конца (T=9.5)', { main: M.main30, overlay: M.ov2s, at: 9.5 }],
    ['08 Overlay в самом конце (T=10)', { main: M.main30, overlay: M.ov2s, at: 10 }],
    ['09 Overlay дальше конца (T=99 → конец)', { main: M.main30, overlay: M.ov2s, at: 99 }],
    ['10 Overlay короткий 1 с, 60 fps, без звука', { main: M.main30, overlay: M.ov1s, at: 3 }],
    ['11 Overlay длинный 30 с, моно 22 кГц', { main: M.main30, overlay: M.ov30s, at: 5 }],
    ['12 main без звука + overlay со звуком', { main: M.main25, overlay: M.ov2s, at: 2 }],
    ['13 main без звука + overlay без звука', { main: M.main25, overlay: M.ov1s, at: 2 }],
    ['14 main 24 fps стерео 48k + overlay 25 fps', { main: M.main24s, overlay: M.ov2s, at: 1.5 }],
    ['15 main 25 fps + overlay 60 fps, размер 100%', { main: M.main25, overlay: M.ov1s, at: 7.5, size: 100 }],
    ['16 VFR main + overlay', { main: M.vfr, overlay: M.ov2s, at: 2, exact: false }],
    ['16b VFR main + Shorts (старый путь)', { main: M.vfr, shorts: M.shorts, percent: 50, exact: false }],
    ['17 Shorts+Overlay: T до Shorts', { main: M.main30, shorts: M.shorts, percent: 50, overlay: M.ov2s, at: 2 }],
    ['18 Shorts+Overlay: T после Shorts', { main: M.main30, shorts: M.shorts, percent: 50, overlay: M.ov2s, at: 7 }],
    ['19 Shorts+Overlay: T = точка Shorts', { main: M.main30, shorts: M.shorts, percent: 50, overlay: M.ov2s, at: 5 }],
    ['20 Shorts 80% + Overlay в начале, overlay без звука', { main: M.main30, shorts: M.shorts, percent: 80, overlay: M.ov1s, at: 0 }],
    ['21 Shorts без звука + Overlay, main без звука', { main: M.main25, shorts: M.shortsQuiet, percent: 70, overlay: M.ov1s, at: 1 }],
    ['21b Overlay по проценту 30%', { main: M.main30, overlay: M.ov2s, freezePercent: 30 }],
    ['21c Overlay 0% и Shorts 90%', { main: M.main30, shorts: M.shorts, percent: 90, overlay: M.ov1s, freezePercent: 0 }],
    ['21d Overlay 100% (в конце)', { main: M.main24s, overlay: M.ov2s, freezePercent: 100 }],
    ['21e Overlay 75% + Shorts 50%', { main: M.main25, shorts: M.shorts, percent: 50, overlay: M.ov2s, freezePercent: 75 }]
  ];
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
  for (const [label, options] of list) {
    if (only && !only.test(label)) continue;
    try {
      await scenario(label, options);
    } catch (err) {
      check(false, `${label}: исключение ${err.stack}`);
    }
  }

  if (!only || only.test('22')) {
    // 22-23: несколько файлов, битый и обрезанный в очереди, overlay включён.
    const t0 = Date.now();
    const before = failures;
    const run = await runBatch('multi', [M.main30, M.broken, M.main25, M.truncated, M.main24s], {
      useShorts: true, useFreeze: true, freezeFile: M.ov2s, freezePercent: 40
    });
    // Один процент на всю очередь: 40% от 10 с, 8 с и 6 с.
    [['1/5', '00:04.000'], ['3/5', '00:03.200'], ['5/5', '00:02.400']].forEach(([index, clock]) => {
      check(run.logs.some((l) => l.message.startsWith(`[${index}] Overlay: стоп-кадр на ${clock} (40%)`)),
        `22 ролик ${index}: момент Overlay не ${clock} (40%)`);
    });
    check(run.summary.done === 3, `22 несколько файлов: готово ${run.summary.done} из 3`);
    check(run.summary.failed === 2, `22 несколько файлов: ошибок ${run.summary.failed} вместо 2`);
    const errors = run.logs.filter((l) => l.level === 'error').map((l) => l.message);
    check(errors.some((m) => /02_main_broken/.test(m) && /пропущен/.test(m)), '23 битый файл не помечен как пропущенный');
    check(errors.some((m) => /04_main_truncated/.test(m)), '23 обрезанный файл не помечен ошибкой');
    const outs = fs.readdirSync(run.out).sort();
    check(outs.includes('es1.mp4') && outs.includes('es3.mp4') && outs.includes('es5.mp4'), `22 файлы результата: ${outs.join(', ')}`);
    check(!outs.includes('es2.mp4') && !outs.includes('es4.mp4'), '23 от битых файлов остались результаты');
    const i30 = await info(M.main30);
    verifyDurations(path.join(run.out, 'es1.mp4'), i30.duration + 3 + 2, '22 es1');
    verifyProgress(run.progress, '22 несколько файлов');
    check(childFfmpegCount() === 0, '22 остались процессы ffmpeg');
    if (failures === before) {
      console.log(`ok 22-23 несколько файлов + битый/обрезанный (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
      passed += 2;
    }
  }

  if (!only || only.test('24')) {
    // 24: ffmpeg упал посреди очереди — полный stderr в логе и в ffmpeg_errors.log, очередь идёт дальше.
    const before = failures;
    const run = await runBatch('stderr', [M.main30, M.main25], {
      useShorts: false, useFreeze: true, freezeFile: M.ov1s, freezeAt: 1
    }, {
      onLog: (level, message, src) => {
        if (/^\[1\/2\] .*оценка/.test(message)) {
          fs.writeFileSync(path.join(src, '01_main30_mono44k.mp4'), Buffer.alloc(2048, 1));
        }
      }
    });
    check(run.summary.done === 1 && run.summary.failed === 1, `24 stderr: готово ${run.summary.done}, ошибок ${run.summary.failed}`);
    const full = run.logs.find((l) => l.level === 'error' && /Полный stderr FFmpeg/.test(l.message));
    check(full && /Команда: .*ffmpeg/.test(full.message) && full.message.split('\n').length > 3,
      '24 полный stderr ffmpeg не попал в лог');
    const errLog = path.join(run.out, 'ffmpeg_errors.log');
    check(fs.existsSync(errLog) && /01_main30_mono44k/.test(fs.readFileSync(errLog, 'utf8')), '24 нет ffmpeg_errors.log');
    check(fs.existsSync(path.join(run.out, 'es2.mp4')) && !fs.existsSync(path.join(run.out, 'es1.mp4')),
      '24 после ошибки очередь не продолжилась');
    check(childFfmpegCount() === 0, '24 остались процессы ffmpeg');
    if (failures === before) {
      console.log('ok 24 падение ffmpeg: полный stderr в логе и ffmpeg_errors.log, очередь продолжилась');
      passed += 1;
    }
  }

  if (!only || only.test('25')) {
    // 25: планировщик — T на кадровой сетке, края, слияние с точкой Shorts.
    const before = failures;
    const media = { duration: 1.01 };
    const p1 = processor.planFreeze({ at: 0.012, media, sourceDuration: 10, fps: 30 });
    check(p1.at === 0 && p1.frames === 30, `25 T<кадра → 0: ${JSON.stringify(p1)}`);
    const p1b = processor.planFreeze({ at: 0.02, media, sourceDuration: 10, fps: 30 });
    check(p1b.frameIndex === 1, `25 T округляется к ближайшему кадру: ${p1b.frameIndex}`);
    const p2 = processor.planFreeze({ at: 9.99, media, sourceDuration: 10, fps: 30 });
    check(p2.at === 10, `25 T у самого конца → конец: ${p2.at}`);
    const p3 = processor.planFreeze({ at: 32.0166, media, sourceDuration: 60, fps: 30 });
    check(Math.abs(p3.at - 32) < 1e-9 && p3.frameIndex === 960, `25 T на сетке: ${p3.at} кадр ${p3.frameIndex}`);
    const p4 = processor.planFreeze({ at: 120, media, sourceDuration: 60, fps: 25 });
    check(p4.at === 60 && p4.clamped, '25 T больше ролика ограничивается концом');
    check(processor.formatClock(32) === '00:32.000' && processor.formatClock(75.5) === '01:15.500', '25 формат 00:32.000');
    const inputs = [];
    const segs = processor.planInsertSegments({
      source: { file: 'a', duration: 10, fps: 30 },
      shorts: { file: 's', duration: 3, fps: 30 },
      splitAt: 5,
      freeze: { at: 5.01, duration: 1, media: { file: 'o' }, size: 70 },
      fps: 30,
      inputs,
      inputBase: 0
    });
    check(segs.length === 3 && segs[1].media.file === 's' && segs[2].freeze && segs[2].freeze.mode === 'start',
      '25 T в пределах кадра от Shorts сливается с точкой Shorts');
    if (failures === before) {
      console.log('ok 25 планировщик Overlay');
      passed += 1;
    }
  }

  console.log(`\nСценариев пройдено: ${passed}, проверок провалено: ${failures}`);
  if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
