'use strict';

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shorts Inserter — файл дизайна</title>
  <style>
${css}

/* --- страница гайда (не часть приложения) --- */
html, body { height: auto; overflow: auto; user-select: text; }
.guide { max-width: 1180px; margin: 0 auto; padding: 28px 24px 80px; }
.guide h1.guide__title { font-size: 28px; margin: 0 0 6px; }
.guide__lead { color: var(--text-dim); margin: 0 0 28px; }
.guide h2.guide__h { margin: 36px 0 14px; font-size: 16px; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-dim); }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.swatch { border: 1px solid var(--border-soft); border-radius: 12px; overflow: hidden; background: var(--panel); }
.swatch__chip { height: 56px; }
.swatch__meta { padding: 8px 10px 10px; font-size: 11.5px; }
.swatch__meta b { display: block; color: var(--text); font-weight: 600; }
.swatch__meta span { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.preview-frame {
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
  min-height: 720px;
  background: var(--bg);
}
.preview-frame .app { height: 720px; }
.type-sample { margin: 0 0 10px; }
.type-sample small { color: var(--text-faint); margin-left: 10px; font-family: var(--mono); }
  </style>
</head>
<body>
  <div class="guide">
    <header class="topbar" style="margin-bottom: 20px;">
      <div class="brand">
        <div class="brand__mark">SI</div>
        <div class="brand__text">
          <h1>Shorts Inserter</h1>
          <p>Файл дизайна — токены, компоненты и макет интерфейса</p>
        </div>
      </div>
      <div class="topbar__meta">
        <span class="chip">v1.7.3</span>
        <span class="chip chip--muted">styles.css + index.html</span>
      </div>
    </header>

    <h1 class="guide__title">Дизайн-система</h1>
    <p class="guide__lead">
      Тёмный UI, акцент фиолетовый → синий. Шрифт Segoe UI / Inter 14px.
      Карточки 14px radius, поля 10px. Этот файл открывается в браузере, Electron не нужен.
    </p>

    <h2 class="guide__h">Цвета</h2>
    <div class="swatches">
      <div class="swatch"><div class="swatch__chip" style="background:#0d1117"></div><div class="swatch__meta"><b>bg</b><span>#0d1117</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#121824"></div><div class="swatch__meta"><b>bg-soft</b><span>#121824</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#161d2b"></div><div class="swatch__meta"><b>panel</b><span>#161d2b</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#1c2534"></div><div class="swatch__meta"><b>panel-2</b><span>#1c2534</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#263047"></div><div class="swatch__meta"><b>border</b><span>#263047</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#e8eefc"></div><div class="swatch__meta"><b>text</b><span>#e8eefc</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#93a1bb"></div><div class="swatch__meta"><b>text-dim</b><span>#93a1bb</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#64718c"></div><div class="swatch__meta"><b>text-faint</b><span>#64718c</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:linear-gradient(135deg,#7c5cff,#4f8cff)"></div><div class="swatch__meta"><b>accent</b><span>#7c5cff → #4f8cff</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#34d399"></div><div class="swatch__meta"><b>success</b><span>#34d399</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#f87171"></div><div class="swatch__meta"><b>danger</b><span>#f87171</span></div></div>
      <div class="swatch"><div class="swatch__chip" style="background:#fbbf24"></div><div class="swatch__meta"><b>warning</b><span>#fbbf24</span></div></div>
    </div>

    <h2 class="guide__h">Типографика</h2>
    <p class="type-sample" style="font-size:19px;font-weight:600;margin:0">Shorts Inserter <small>H1 · 19px · 600</small></p>
    <p class="type-sample" style="font-size:14px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase">1. Источники <small>H2 карточки · 14px · uppercase</small></p>
    <p class="type-sample" style="font-size:14px;color:#e8eefc">Основной текст 14px / 1.5</p>
    <p class="type-sample" style="font-size:12.5px;color:#93a1bb">Подпись поля 12.5px · text-dim</p>
    <p class="type-sample" style="font-size:11.5px;color:#64718c;font-family:var(--mono)">C:\\Users\\PC\\Downloads\\A4 <small>mono 11.5–12px</small></p>

    <h2 class="guide__h">Кнопки и чипы</h2>
    <div class="row">
      <button class="btn btn--primary">Начать обработку</button>
      <button class="btn btn--danger">Остановить</button>
      <button class="btn btn--ghost">Обзор…</button>
      <button class="btn btn--mini">Копировать</button>
      <button class="btn" disabled>Неактивна</button>
    </div>
    <div class="row">
      <span class="chip">v1.7.3</span>
      <span class="chip chip--muted">FFmpeg: bundled</span>
      <span class="badge">Ожидание</span>
      <span class="badge badge--running">Идёт</span>
      <span class="badge badge--done">Готово</span>
      <span class="badge badge--error">Ошибка</span>
      <button class="tab is-active">Вставка Shorts</button>
      <button class="tab">Скачивание YouTube</button>
    </div>

    <h2 class="guide__h">Поля</h2>
    <div class="card" style="max-width:560px">
      <div class="field">
        <label>Папка с исходными видео</label>
        <div class="picker">
          <input type="text" value="C:\\Users\\PC\\Downloads\\A4" readonly />
          <button class="btn btn--ghost">Обзор…</button>
        </div>
        <p class="field__note field__note--ok">Найдено видео: 24</p>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Процент обрезки: <b>80%</b></label>
          <div class="percent-row">
            <input type="number" value="80" min="50" max="99" />
            <input type="range" min="50" max="99" value="80" />
          </div>
        </div>
        <div class="field">
          <label>Кодек результата</label>
          <select>
            <option>H.264 — быстро (veryfast)</option>
            <option>H.265 — быстро (veryfast)</option>
            <option>ProRes 422 HQ</option>
          </select>
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" checked />
        <span class="switch__track"><span class="switch__thumb"></span></span>
        <span class="switch__label">Разделить экран</span>
      </label>
    </div>

    <h2 class="guide__h">Схема монтажа и сплит</h2>
    <div class="card">
      <div class="scheme">
        <div class="scheme__bar">
          <span class="scheme__part scheme__part--head" style="flex-basis:56%">Исходник 80%</span>
          <span class="scheme__part scheme__part--shorts">Shorts</span>
          <span class="scheme__part scheme__part--tail">20%</span>
        </div>
        <div class="scheme__overlay">Оверлей поверх всего хронометража</div>
      </div>
      <div class="split-preview">
        <div class="split-preview__left"><span>Основной ролик</span></div>
        <div class="split-preview__seam"></div>
        <div class="split-preview__right"><span>Крупный план</span></div>
      </div>
    </div>

    <h2 class="guide__h">Прогресс и лог</h2>
    <div class="grid-2">
      <article class="card card--progress">
        <div class="card__head">
          <h2>Прогресс</h2>
          <span class="badge badge--running">Идёт</span>
        </div>
        <p class="status">Обработка 3/24: clip12.mp4 — 62.4%</p>
        <div class="progress">
          <div class="progress__label"><span>Текущий файл</span><span>62%</span></div>
          <div class="progress__track"><div class="progress__fill" style="width:62%"></div></div>
        </div>
        <div class="progress">
          <div class="progress__label"><span>Всего</span><span>11%</span></div>
          <div class="progress__track"><div class="progress__fill progress__fill--overall" style="width:11%"></div></div>
        </div>
        <div class="counters">
          <div class="counter"><span>2</span><small>готово</small></div>
          <div class="counter"><span>0</span><small>ошибок</small></div>
          <div class="counter"><span>24</span><small>всего</small></div>
        </div>
      </article>
      <article class="card card--log">
        <div class="card__head"><h2>Лог выполнения</h2></div>
        <div class="log">
          <div class="log__row log__row--info"><span class="log__time">12:04:01</span><span class="log__text">Найдено видео: 24</span></div>
          <div class="log__row log__row--info"><span class="log__time">12:04:01</span><span class="log__text">Кодек: H.264, обрезка: 80%</span></div>
          <div class="log__row log__row--success"><span class="log__time">12:04:18</span><span class="log__text">[1/24] Готово: es1.mp4 (18.4 МБ)</span></div>
          <div class="log__row log__row--warn"><span class="log__time">12:04:19</span><span class="log__text">Пауза 120 мс между файлами</span></div>
          <div class="log__row log__row--error"><span class="log__time">12:04:22</span><span class="log__text">[3/24] Ошибка на файле broken.mp4</span></div>
        </div>
      </article>
    </div>

    <h2 class="guide__h">Макет окна — вкладка «Вставка Shorts»</h2>
    <div class="preview-frame">
      <div class="app">
        <header class="topbar">
          <div class="brand">
            <div class="brand__mark">SI</div>
            <div class="brand__text">
              <h1>Shorts Inserter</h1>
              <p>Вставка Shorts в середину видео и массовое скачивание YouTube с умной очередью</p>
            </div>
          </div>
          <div class="topbar__meta">
            <span class="chip">v1.7.3</span>
            <span class="chip chip--muted">FFmpeg: bundled</span>
            <span class="chip chip--muted">yt-dlp: bundled</span>
          </div>
        </header>
        <nav class="tabs">
          <button type="button" class="tab is-active">Вставка Shorts</button>
          <button type="button" class="tab">Скачивание YouTube</button>
          <button type="button" class="tab">Умное переименование</button>
        </nav>
        <main class="layout">
          <section class="column column--settings">
            <article class="card">
              <div class="card__head">
                <h2>1. Источники</h2>
                <span class="card__hint">Что и куда вставляем</span>
              </div>
              <div class="field">
                <label>Папка с исходными видео</label>
                <div class="picker">
                  <input type="text" value="C:\\Users\\PC\\Downloads\\исходники" readonly />
                  <button class="btn btn--ghost">Обзор…</button>
                </div>
              </div>
              <div class="field">
                <label>Файл Shorts</label>
                <div class="picker">
                  <input type="text" value="C:\\Users\\PC\\Downloads\\shorts.mp4" readonly />
                  <button class="btn btn--ghost">Обзор…</button>
                </div>
              </div>
            </article>
            <article class="card">
              <div class="card__head">
                <h2>2. Сплит-скрин</h2>
                <label class="switch">
                  <input type="checkbox" checked />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                  <span class="switch__label">Разделить экран</span>
                </label>
              </div>
              <div class="split-preview">
                <div class="split-preview__left"><span>Основной ролик</span></div>
                <div class="split-preview__seam"></div>
                <div class="split-preview__right"><span>Крупный план</span></div>
              </div>
            </article>
            <article class="card">
              <div class="card__head">
                <h2>4. Экспорт</h2>
                <span class="card__hint">Результат: es1.mp4, es2.mp4, …</span>
              </div>
              <div class="scheme">
                <div class="scheme__bar">
                  <span class="scheme__part scheme__part--head" style="flex-basis:56%">Исходник 80%</span>
                  <span class="scheme__part scheme__part--shorts">Shorts</span>
                  <span class="scheme__part scheme__part--tail">20%</span>
                </div>
              </div>
            </article>
            <div class="actions">
              <button class="btn btn--primary">Начать обработку</button>
              <button class="btn btn--danger" disabled>Остановить</button>
              <button class="btn btn--ghost">Открыть папку результата</button>
            </div>
          </section>
          <section class="column column--status">
            <article class="card card--progress">
              <div class="card__head">
                <h2>Прогресс</h2>
                <span class="badge">Ожидание</span>
              </div>
              <p class="status">Готово к запуску.</p>
              <div class="progress">
                <div class="progress__label"><span>Текущий файл</span><span>0%</span></div>
                <div class="progress__track"><div class="progress__fill"></div></div>
              </div>
              <div class="progress">
                <div class="progress__label"><span>Всего</span><span>0%</span></div>
                <div class="progress__track"><div class="progress__fill progress__fill--overall"></div></div>
              </div>
              <div class="counters">
                <div class="counter"><span>0</span><small>готово</small></div>
                <div class="counter"><span>0</span><small>ошибок</small></div>
                <div class="counter"><span>0</span><small>всего</small></div>
              </div>
            </article>
            <article class="card card--log">
              <div class="card__head"><h2>Лог выполнения</h2></div>
              <div class="log"><p class="log__empty">Лог пуст. Запустите обработку.</p></div>
            </article>
          </section>
        </main>
      </div>
    </div>

    <h2 class="guide__h">Исходники в репозитории</h2>
    <p class="guide__lead">
      Живой интерфейс приложения: <code>index.html</code> + <code>styles.css</code>.
      Этот гайд — статичная копия для просмотра и передачи дизайнеру.
    </p>
  </div>
</body>
</html>
`;

const out = path.join(__dirname, 'Shorts-Inserter-design.html');
fs.writeFileSync(out, html);
console.log('wrote', out, fs.statSync(out).size, 'bytes');
