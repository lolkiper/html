'use strict';

/** Полоса языковых вкладок. Сами вкладки — отдельные страницы index.html в main-процессе. */

const tabsNode = document.getElementById('ws-tabs');
const buttons = new Map();

function pill(text, modifier, title) {
  const node = document.createElement('span');
  node.className = `pill${modifier ? ` pill--${modifier}` : ''}`;
  node.textContent = text;
  if (title) node.title = title;
  return node;
}

function buildButton(ws) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ws-tab';
  button.setAttribute('role', 'tab');
  button.dataset.id = ws.id;

  const flag = document.createElement('span');
  flag.className = 'ws-tab__flag';
  const name = document.createElement('span');
  name.className = 'ws-tab__name';
  const code = document.createElement('span');
  code.className = 'ws-tab__code';
  const status = document.createElement('span');
  status.className = 'ws-tab__status';

  button.append(flag, name, code, status);
  button.addEventListener('click', () => window.shellApi.activate(ws.id));
  tabsNode.appendChild(button);
  const entry = { button, flag, name, code, status };
  buttons.set(ws.id, entry);
  return entry;
}

function render(state) {
  if (!state || !Array.isArray(state.workspaces)) return;
  state.workspaces.forEach((ws, index) => {
    const entry = buttons.get(ws.id) || buildButton(ws);
    const active = ws.id === state.active;
    entry.button.classList.toggle('is-active', active);
    entry.button.setAttribute('aria-selected', String(active));
    entry.button.title = `${ws.name} — Ctrl+${index + 1}. Файлы результата: ${ws.code}1.mp4, ${ws.code}2.mp4…`;
    entry.flag.textContent = ws.flag;
    entry.name.textContent = ws.name;
    entry.code.textContent = ws.code;

    const pills = [];
    if (ws.rendering) {
      pills.push(pill(`▶ ${Math.floor(ws.renderPercent)}%`, 'render', 'Идёт монтаж'));
    }
    if (ws.downloading) {
      pills.push(ws.downloadPaused
        ? pill('⏸', 'pause', 'Скачивание на паузе')
        : pill(`⬇ ${ws.downloadDone}/${ws.downloadTotal}`, null, 'Идёт скачивание'));
    }
    if (ws.conflicts) pills.push(pill('⚠', 'warn', 'Папка совпадает с папкой другой вкладки'));
    entry.status.replaceChildren(...pills);
  });
}

window.shellApi.onState(render);
window.shellApi.getState().then(render);
