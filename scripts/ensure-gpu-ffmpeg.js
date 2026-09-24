'use strict';

/**
 * Windows-сборка: если в ffmpeg-static нет NVENC/AMF/QSV, подменяем бинарник
 * на GPL-сборку BtbN, где GPU-кодеки точно есть.
 *
 *   node scripts/ensure-gpu-ffmpeg.js
 *
 * На Linux/macOS ничего не качает — там johnvansickle/evermeet без NVENC.
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BTBN_ZIP =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl.zip';

function hasGpuEncoders(ffmpegBin) {
  if (!ffmpegBin || !fs.existsSync(ffmpegBin)) return false;
  let text = '';
  try {
    text = execFileSync(ffmpegBin, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    text = `${err.stdout || ''}\n${err.stderr || ''}`;
  }
  const found = [];
  ['h264_nvenc', 'hevc_nvenc', 'h264_amf', 'h264_qsv'].forEach((id) => {
    if (text.includes(id)) found.push(id);
  });
  return found;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (current) => {
      https
        .get(current, { headers: { 'User-Agent': 'shorts-inserter' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Скачивание FFmpeg: HTTP ${res.statusCode}`));
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

function findFfmpegExe(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const names = fs.readdirSync(dir);
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (name.toLowerCase() === 'ffmpeg.exe') return full;
    }
  }
  return null;
}

async function main() {
  let bundled = null;
  try {
    bundled = require('ffmpeg-static');
  } catch (err) {
    console.warn('ffmpeg-static не установлен, пропускаю.');
    return;
  }

  const present = hasGpuEncoders(bundled);
  if (present.length) {
    console.log(`GPU-кодеки уже есть: ${present.join(', ')}`);
    return;
  }

  if (process.platform !== 'win32') {
    console.log('GPU-кодеков в этой сборке FFmpeg нет (на Linux/macOS это ожидаемо).');
    return;
  }

  console.log('В ffmpeg-static нет NVENC/AMF/QSV — скачиваю сборку BtbN с GPU-кодеками…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-gpu-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  const unpacked = path.join(tmp, 'unpacked');
  fs.mkdirSync(unpacked);

  await download(BTBN_ZIP, zip);
  execFileSync('tar', ['-xf', zip, '-C', unpacked], { stdio: 'inherit' });
  const replacement = findFfmpegExe(unpacked);
  if (!replacement) {
    throw new Error('В архиве BtbN не найден ffmpeg.exe');
  }

  fs.copyFileSync(replacement, bundled);
  const after = hasGpuEncoders(bundled);
  if (!after.length) {
    throw new Error('После подмены FFmpeg всё ещё без GPU-кодеков');
  }
  console.log(`Подменил ${bundled} → GPU-кодеки: ${after.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
