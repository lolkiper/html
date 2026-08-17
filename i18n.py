"""Interface language: Russian by default, English available.

Every user-visible string goes through :func:`tr`.  Log messages are translated
too: the engine logs with format templates and :class:`logger.EventLog` runs the
template through :func:`tr` before inserting the values, so one hook covers the
whole engine.

A translation must keep the same format placeholders as its English key;
:func:`validate_translations` checks that and is asserted by the test suite.
"""

from __future__ import annotations

import re
from typing import Iterable

DEFAULT_LANGUAGE = "ru"
LANGUAGE_LABELS = {"ru": "Русский", "en": "English"}
PLACEHOLDER = re.compile(r"%(?:\((?P<name>[^)]*)\))?[-+ #0]*[\d*]*(?:\.[\d*]+)?[hlL]?(?P<type>[a-zA-Z%])")

_language = DEFAULT_LANGUAGE

RU: dict[str, str] = {
    # ------------------------------------------------------------ main window
    "LDPlayer Visual UI Tester": "LDPlayer Visual UI Tester — визуальный тестер интерфейса",
    "New": "Новый",
    "Open...": "Открыть...",
    "Save": "Сохранить",
    "Save as...": "Сохранить как...",
    "LDPlayer:": "LDPlayer:",
    "Refresh": "Обновить",
    "Select": "Выбрать",
    "Screen region...": "Область экрана...",
    "Engine mode:": "Режим движка:",
    "Dry run (analyse only, no input)": "Пробный прогон (только анализ, без ввода)",
    "F8 start/pause    F9 emergency stop": "F8 старт/пауза    F9 аварийный стоп",
    "F8 start/pause    F9 stop    F10 step": "F8 старт/пауза    F9 стоп    F10 шаг",
    "STEP BY STEP (F10)": "ШАГ ЗА ШАГОМ (F10)",
    "▶ START (F8)": "▶ СТАРТ (F8)",
    "⏸ PAUSE (F8)": "⏸ ПАУЗА (F8)",
    "■ STOP (F9)": "■ СТОП (F9)",
    "Analyze once": "Разобрать экран",
    "Language:": "Язык:",
    # ------------------------------------------------------------ left panel
    "States": "Состояния",
    "State": "Состояние",
    "Conf.": "Увер.",
    "Refs": "Этал.",
    "Acts": "Дейст.",
    "ADD STATE": "ДОБАВИТЬ СОСТОЯНИЕ",
    "Edit": "Изменить",
    "Copy": "Копия",
    "Delete": "Удалить",
    "Detection test": "Проверка распознавания",
    "Analyze the current screen": "Разобрать текущий экран",
    "Confidence": "Уверенность",
    "Position": "Позиция",
    "No frame captured yet": "Кадр ещё не захвачен",
    # ---------------------------------------------------------- centre panel
    "Scenario": "Сценарий",
    "  (select a box or a branch, then add a step)":
        "  (выберите блок или ветку, затем добавьте шаг)",
    "ADD CONDITION": "ДОБАВИТЬ УСЛОВИЕ",
    "ADD ACTION": "ДОБАВИТЬ ДЕЙСТВИЕ",
    "ADD VERIFY": "ДОБАВИТЬ ПРОВЕРКУ",
    "ADD ELSE": "ДОБАВИТЬ ИНАЧЕ",
    "ADD WAIT": "ДОБАВИТЬ ПАУЗУ",
    "ADD RETRY": "ДОБАВИТЬ ПОВТОР",
    "ADD ANALYZE": "ДОБАВИТЬ АНАЛИЗ",
    "ADD LOOP": "ДОБАВИТЬ ЦИКЛ",
    "ADD STOP": "ДОБАВИТЬ СТОП",
    "RECORD MACRO": "ЗАПИСАТЬ МАКРОС",
    "RECORD MACRO 2": "ЗАПИСАТЬ MACRO_2",
    "CAPTURE ERROR STATE": "ЗАХВАТИТЬ СОСТОЯНИЕ ОШИБКИ",
    "CAPTURE SUCCESS STATE": "ЗАХВАТИТЬ СОСТОЯНИЕ УСПЕХА",
    "CAPTURE MACRO 2 ERROR STATE": "ЗАХВАТИТЬ ОШИБКУ MACRO_2",
    "CAPTURE MACRO 2 SUCCESS STATE": "ЗАХВАТИТЬ УСПЕХ MACRO_2",
    "MACRO": "МАКРОС",
    "MACROS": "МАКРОСЫ",
    "STATES": "СОСТОЯНИЯ",
    "Pipeline": "Пайплайн",
    "Record": "Запись",
    "Test": "Прогон",
    "Capture": "Захват",
    "Test detection": "Проверить распознавание",
    "TEST DATA": "ТЕСТОВЫЕ ДАННЫЕ",
    "login / password — AUTH_VK types these; passwords are not logged":
        "login / password — AUTH_VK подставляет эти поля; пароли в журнал не пишутся",
    "+ Add row": "+ Строка",
    "Test data row": "Тестовая запись",
    "On/off": "Вкл/выкл",
    # ---------------------------------------------------------- right panel
    "Details": "Подробности",
    "Validation": "Проверка проекта",
    "Warnings": "Предупреждения",
    "Check the project": "Проверить проект",
    "Engine settings...": "Настройки движка...",
    "No problems found.": "Проблем не найдено.",
    "Selected branch: %s": "Выбранная ветка: %s",
    "Condition: %s": "Условие: %s",
    "Action: %s": "Действие: %s",
    "Timeout: %gs, check every %gs": "Таймаут: %g с, проверка каждые %g с",
    "Attempts: %s, delay %gs": "Попыток: %s, пауза %g с",
    "Count: %s, iteration limit %s": "Итераций: %s, предел %s",
    "This step is disabled.": "Шаг отключён.",
    "RUNNING - ": "ВЫПОЛНЯЕТСЯ — ",
    "STATE %s": "СОСТОЯНИЕ %s",
    "(no description)": "(без описания)",
    "Reference images:": "Эталонные изображения:",
    "Actions:": "Действия:",
    "Expected: %s": "Ожидается: %s",
    "Verification timeout: %gs": "Таймаут проверки: %g с",
    "Retries: %s (delay %gs), cooldown %gs": "Повторов: %s (пауза %g с), задержка %g с",
    "Fallback: %s": "Откат: %s",
    # ------------------------------------------------------------- log panel
    "Live log": "Журнал",
    "Autoscroll": "Автопрокрутка",
    "Clear": "Очистить",
    "Save log...": "Сохранить журнал...",
    "Save the log": "Сохранить журнал",
    "Text log": "Текстовый журнал",
    # ------------------------------------------------------------ status bar
    "No LDPlayer selected": "LDPlayer не выбран",
    "%s (window lost)": "%s (окно потеряно)",
    "Engine: %s   |   Run: %s   |   State: %s (%.2f)   |   Frames: %s   |   Cycles: %s   |   OCR: %s   |   %s":
        "Движок: %s   |   Прогон: %s   |   Состояние: %s (%.2f)   |   Кадров: %s   |   Циклов: %s   |   OCR: %s   |   %s",
    "DRY RUN": "ПРОБНЫЙ ПРОГОН",
    "LIVE INPUT": "РЕАЛЬНЫЙ ВВОД",
    # -------------------------------------------------------------- dialogs
    "OK": "ОК",
    "Cancel": "Отмена",
    "Add": "Добавить",
    "Remove": "Убрать",
    "Up": "Вверх",
    "Down": "Вниз",
    "Edit...": "Изменить...",
    "Region...": "Область...",
    "Invalid value": "Неверное значение",
    "%s is not a number.": "%s — не число.",
    "Type": "Тип",
    "Condition": "Условие",
    "Action": "Действие",
    "Target": "Цель",
    "Destination": "Куда",
    "Actions": "Действия",
    "Sub-conditions": "Подусловия",
    "NOT inverts one condition": "НЕ инвертирует одно условие",
    "Limit": "Ограничение",
    "NOT takes a single condition.": "НЕ принимает только одно условие.",
    "Missing condition": "Нет условия",
    "NOT needs one condition.": "Для НЕ нужно одно условие.",
    "Invalid condition": "Неверное условие",
    "Invalid action": "Неверное действие",
    "%s position": "%s: положение",
    "Condition (optional)": "Условие (необязательно)",
    "Region of interest (0..1)": "Область интереса (0..1)",
    "Select region": "Выбор области",
    "Select the region on the current LDPlayer screen?\nChoose No to type the values manually.":
        "Выделить область на текущем экране LDPlayer?\nНет — ввести значения вручную.",
    "Select a region": "Выделите область",
    "Select the region to remember": "Выделите область, которую нужно запомнить",
    "Drag to select. The frame is only shown, never saved.":
        "Выделите область мышью. Кадр только показывается и не сохраняется.",
    "The frame is black: LDPlayer is covered or GPU capture failed. "
    "Move this window aside, uncover the emulator, then try again. "
    "Engine settings → Capture backend → mss.":
        "Кадр чёрный: LDPlayer перекрыт или GPU-захват не сработал. "
        "Отодвиньте это окно, чтобы был виден эмулятор, и повторите. "
        "Настройки движка → Захват → mss.",
    "Use selection": "Использовать",
    "Whole screen": "Весь экран",
    "No selection": "Ничего не выделено",
    "Drag a rectangle first.": "Сначала выделите прямоугольник.",
    "Pillow required": "Нужен Pillow",
    "Selecting a region on screen needs Pillow (pip install Pillow).\nYou can still add a reference image from a file.":
        "Для выделения области нужен Pillow (pip install Pillow).\nЭталон можно добавить из файла.",
    "Reference image name": "Имя эталонного изображения",
    "Replace": "Заменить",
    "Replace the image '%s'?": "Заменить изображение «%s»?",
    # ------------------------------------------------------------ form fields
    "Name": "Имя",
    "Value": "Значение",
    "Value is true": "Значение истинно",
    "Minimum confidence": "Минимальная уверенность",
    "empty = state default": "пусто = значение состояния",
    "empty = default": "пусто = по умолчанию",
    "empty = target default": "пусто = значение цели",
    "optional": "необязательно",
    "Reference image": "Эталонное изображение",
    "Region": "Область",
    "Grayscale": "В оттенках серого",
    "Match mode": "Способ сравнения",
    "Text": "Текст",
    "OCR confidence": "Уверенность OCR",
    "Regular expression": "Регулярное выражение",
    "Ignore case": "Игнорировать регистр",
    "Whole line": "Строка целиком",
    "Operator": "Оператор",
    "Number index": "Номер числа",
    "X (0..1)": "X (0..1)",
    "Y (0..1)": "Y (0..1)",
    "X (0..1 or px)": "X (0..1 или пикс.)",
    "Y (0..1 or px)": "Y (0..1 или пикс.)",
    "Colour B,G,R": "Цвет B,G,R",
    "Tolerance (0..1)": "Допуск (0..1)",
    "Tolerance (0..255)": "Допуск (0..255)",
    "Minimum coverage": "Минимальная доля",
    "Difference threshold": "Порог различия",
    "Variable": "Переменная",
    "Units": "Единицы",
    "Text to find": "Искомый текст",
    "Search region": "Область поиска",
    "Offset X (px)": "Смещение X (пикс.)",
    "Offset Y (px)": "Смещение Y (пикс.)",
    "Anchor": "Привязка",
    "Cooldown (s)": "Задержка (с)",
    "Required confidence": "Требуемая уверенность",
    "Duration (s)": "Длительность (с)",
    "Key": "Клавиша",
    "Presses": "Нажатий",
    "Interval (s)": "Интервал (с)",
    "Combination": "Комбинация",
    "Sensitive (never logged)": "Чувствительный текст (не пишется в журнал)",
    "Read from variable": "Взять из переменной",
    "Clear the field first": "Сначала очистить поле",
    "Seconds": "Секунды",
    "Random extra (s)": "Случайная добавка (с)",
    "Timeout (s)": "Таймаут (с)",
    "Check every (s)": "Проверять каждые (с)",
    "Wait for true": "Ждать выполнения",
    "Expected state": "Ожидаемое состояние",
    "Times": "Раз",
    "Delay (s)": "Пауза (с)",
    "Stop on failure": "Остановиться при ошибке",
    "Reason": "Причина",
    "Mode": "Режим",
    "Message": "Сообщение",
    "Level": "Уровень",
    "Left": "Слева",
    "Top": "Сверху",
    "Width": "Ширина",
    "Height": "Высота",
    "X": "X",
    "Y": "Y",
    "Image": "Изображение",
    "Allow scale changes": "Разрешить изменение масштаба",
    "Wait for state (optional)": "Ждать состояние (необязательно)",
    "Wait seconds": "Пауза, с",
    "Wait until a condition instead": "Вместо паузы ждать условие",
    "Attempts": "Попыток",
    "Delay between attempts (s)": "Пауза между попытками (с)",
    "Iterations (0 = while a condition holds)": "Итераций (0 = пока верно условие)",
    "Iteration limit": "Предел итераций",
    "Add SUCCESS / FAILED branches": "Добавить ветки УСПЕХ / ОШИБКА",
    "Edit the condition too": "Также изменить условие",
    # ----------------------------------------------------------- state editor
    "Visual state": "Визуальное состояние",
    "Detection": "Распознавание",
    "Description": "Описание",
    "Reference images must": "Эталонные изображения должны совпасть",
    "Reference images": "Эталонные изображения",
    "From current screen...": "С текущего экрана...",
    "From file...": "Из файла...",
    "Extra condition (AND with the images)": "Дополнительное условие (И с изображениями)",
    "Actions performed when this state is detected":
        "Действия при обнаружении этого состояния",
    "Record...": "Записать...",
    "Result and timing": "Результат и время",
    "Expected state after the actions": "Ожидаемое состояние после действий",
    "Fallback (state name or STOP)": "Откат (имя состояния или STOP)",
    "Next state to wait for": "Следующее ожидаемое состояние",
    "State timeout (s)": "Таймаут состояния (с)",
    "Verification timeout (s)": "Таймаут проверки (с)",
    "Retry count": "Число повторов",
    "Retry delay (s)": "Пауза перед повтором (с)",
    "Terminal state (a successful run ends here)":
        "Конечное состояние (успешный прогон здесь завершается)",
    "Enabled": "Включено",
    "Expected result condition": "Условие ожидаемого результата",
    "Missing name": "Не указано имя",
    "The state needs a name.": "У состояния должно быть имя.",
    "Delete state": "Удаление состояния",
    "Delete '%s'?": "Удалить «%s»?",
    "Images": "Изображения",
    "All files": "Все файлы",
    # -------------------------------------------------------- recorder dialog
    "Record actions": "Запись действий",
    "Record the actions you perform in LDPlayer, then reuse them as a step.":
        "Выполните действия в LDPlayer — они запишутся и станут шагами сценария.",
    "Insert pauses between actions": "Вставлять паузы между действиями",
    "Anchor clicks to images (resistant to shifts)":
        "Привязывать клики к изображениям (устойчиво к смещению)",
    "Merge typed characters into one text action":
        "Объединять набранные символы в один ввод текста",
    "Recorded steps": "Записанные шаги",
    "Start recording": "Начать запись",
    "Stop": "Остановить",
    "Use the recording": "Использовать запись",
    "INSERT VARIABLE": "ВСТАВИТЬ ПЕРЕМЕННУЮ",
    "CUSTOM VARIABLE": "СВОЯ ПЕРЕМЕННАЯ",
    "Start recording first": "Сначала начните запись",
    "Enter a variable name (A-Z, digits, underscore).":
        "Введите имя переменной (латиница, цифры, подчёркивание).",
    "Invalid variable name": "Неверное имя переменной",
    "The name must start with a letter or underscore.":
        "Имя должно начинаться с буквы или подчёркивания.",
    "Resolve as variable": "Подставлять как переменную",
    "Recording... switch to LDPlayer and act. %s to stop.":
        "Идёт запись... переключитесь на LDPlayer. %s — остановить.",
    "Recording stopped: %s step(s)": "Запись остановлена, шагов: %s",
    "Ready to record": "Готово к записи",
    "Nothing recorded": "Ничего не записано",
    "Perform at least one action inside the emulator window.":
        "Выполните хотя бы одно действие в окне эмулятора.",
    "Recording is unavailable": "Запись недоступна",
    "Install the 'pynput' package to record actions (pip install pynput).":
        "Для записи действий установите пакет «pynput» (pip install pynput).",
    "Save the project before anchoring clicks to images.":
        "Сохраните проект, прежде чем привязывать клики к изображениям.",
    "Recorded %s action(s)": "Записано действий: %s",
    "Add the recording to a state": "Добавить запись в состояние",
    "The recorded actions were added to the state '%s'.":
        "Записанные действия добавлены в состояние «%s».",
    # -------------------------------------------------------------- settings
    "Engine settings": "Настройки движка",
    "Default confidence": "Уверенность по умолчанию",
    "Ambiguity margin": "Порог неоднозначности",
    "Click cooldown (s)": "Задержка между кликами (с)",
    "Max actions / minute": "Максимум действий в минуту",
    "Require the window in front": "Требовать окно на переднем плане",
    "Capture backend": "Способ захвата",
    "OCR engine": "Движок OCR",
    "OCR language": "Язык OCR",
    "OCR upscaling": "Увеличение для OCR",
    "Repeat the workflow": "Повторять сценарий",
    "Delay between cycles (s)": "Пауза между циклами (с)",
    "Max cycles (0 = unlimited)": "Максимум циклов (0 = без предела)",
    "Inset left (px)": "Отступ слева (пикс.)",
    "Inset top (px)": "Отступ сверху (пикс.)",
    "Inset right (px)": "Отступ справа (пикс.)",
    "Inset bottom (px)": "Отступ снизу (пикс.)",
    "Interface language": "Язык интерфейса",
    # -------------------------------------------------------------- messages
    "No window": "Нет окна",
    "Select an LDPlayer instance first.": "Сначала выберите экземпляр LDPlayer.",
    "Select LDPlayer": "Выбор LDPlayer",
    "Refresh the list and pick an instance.": "Обновите список и выберите экземпляр.",
    "Capture failed": "Не удалось захватить экран",
    "The captured frame is black. Uncover the LDPlayer window "
    "(do not minimise it), move this editor aside, then try again. "
    "If it stays black: Engine settings → Capture backend → mss.":
        "Кадр чёрный. Не сворачивайте LDPlayer, отодвиньте этот редактор, "
        "чтобы было видно окно эмулятора, и повторите. "
        "Если снова чёрный: Настройки движка → Захват → mss.",
    "Screen region": "Область экрана",
    "Open project": "Открыть проект",
    "Open a project folder (*.ldproj)": "Открыть папку проекта (*.ldproj)",
    "Save project": "Сохранить проект",
    "Save the project": "Сохранение проекта",
    "LDPlayer test project": "Проект теста LDPlayer",
    "Unsaved changes": "Несохранённые изменения",
    "Save the current project first?": "Сохранить текущий проект?",
    "Warnings": "Предупреждения",
    "The project has warnings:\n\n%s\n\nStart anyway?":
        "В проекте есть предупреждения:\n\n%s\n\nВсё равно запустить?",
    "No states": "Нет состояний",
    "Create a visual state first.": "Сначала создайте визуальное состояние.",
    "Run a state": "Выполнить состояние",
    "Select an IF": "Выберите ЕСЛИ",
    "Select the IF step you want to extend.": "Выберите шаг ЕСЛИ, который нужно дополнить",
    "Add an ELSE IF branch with its own condition?\nChoose No for a plain ELSE.":
        "Добавить ветку ИНАЧЕ ЕСЛИ со своим условием?\nНет — обычная ветка ИНАЧЕ.",
    "ELSE exists": "ИНАЧЕ уже есть",
    "This IF already has an ELSE branch.": "У этого ЕСЛИ уже есть ветка ИНАЧЕ.",
    "Pillow required": "Нужен Pillow",
    "Reference image": "Эталонное изображение",
    "Capture backend": "Способ захвата",
    "always": "всегда",
    # -------------------------------------------------- workflow / diagram
    "START": "НАЧАЛО",
    "END": "КОНЕЦ",
    "(empty)": "(пусто)",
    "  [disabled]": "  [отключено]",
    "YES": "ДА",
    "ELSE": "ИНАЧЕ",
    "ELSE IF": "ИНАЧЕ ЕСЛИ",
    "ELSE IF %s": "ИНАЧЕ ЕСЛИ %s",
    "BODY": "ТЕЛО",
    "ON FAILURE": "ПРИ ОШИБКЕ",
    "SUCCESS": "УСПЕХ",
    "FAILED": "ОШИБКА",
    "ANALYZE SCREEN": "АНАЛИЗ ЭКРАНА",
    "ANALYZE (wait for %s, timeout %gs)": "АНАЛИЗ (ждать %s, таймаут %g с)",
    "IF %s": "ЕСЛИ %s",
    "ACTION (empty)": "ДЕЙСТВИЕ (пусто)",
    "VERIFY state %s (timeout %gs)": "ПРОВЕРКА состояния %s (таймаут %g с)",
    "VERIFY %s": "ПРОВЕРКА %s",
    "WAIT %gs": "ПАУЗА %g с",
    "WAIT UNTIL %s (timeout %gs)": "ЖДАТЬ ПОКА %s (таймаут %g с)",
    "WAIT WHILE NOT %s (timeout %gs)": "ЖДАТЬ ПОКА НЕ %s (таймаут %g с)",
    "RETRY x%s (delay %gs)": "ПОВТОР x%s (пауза %g с)",
    "LOOP WHILE %s (max %s)": "ЦИКЛ ПОКА %s (макс. %s)",
    "LOOP x%s": "ЦИКЛ x%s",
    "STOP": "СТОП",
    "STOP (%s)": "СТОП (%s)",
    # ------------------------------------------------------------ conditions
    "ALWAYS": "ВСЕГДА",
    "NEVER": "НИКОГДА",
    "STATE %s detected": "СОСТОЯНИЕ %s обнаружено",
    "IMAGE '%s' visible (>= %.2f)": "ИЗОБРАЖЕНИЕ «%s» видно (>= %.2f)",
    "TEXT '%s' visible": "ТЕКСТ «%s» виден",
    "NUMBER %s %g": "ЧИСЛО %s %g",
    "COLOR at (%.2f,%.2f) == %s": "ЦВЕТ в (%.2f,%.2f) == %s",
    "COLOR %s present": "ЦВЕТ %s присутствует",
    "SCREEN changed (>= %.3f)": "ЭКРАН изменился (>= %.3f)",
    "VAR %s %s %s": "ПЕРЕМЕННАЯ %s %s %s",
    "NOT (%s)": "НЕ (%s)",
    " AND ": " И ",
    " OR ": " ИЛИ ",
    "AND": "И",
    "OR": "ИЛИ",
    # ---------------------------------------------------- condition labels
    "Always / Never": "Всегда / никогда",
    "State detected": "Состояние обнаружено",
    "Reference image visible": "Эталонное изображение видно",
    "Text visible": "Текст виден",
    "Number comparison": "Сравнение числа",
    "Pixel colour": "Цвет пикселя",
    "Colour present in region": "Цвет присутствует в области",
    "Screen changed": "Экран изменился",
    "Variable comparison": "Сравнение переменной",
    "NOT": "НЕ",
    # ------------------------------------------------------- action labels
    "Move Mouse": "Подвести мышь",
    "Left Click": "Левый клик",
    "Double Click": "Двойной клик",
    "Right Click": "Правый клик",
    "Drag": "Перетаскивание",
    "Press Key": "Нажать клавишу",
    "Hotkey": "Горячие клавиши",
    "Type Text": "Ввести текст",
    "Wait": "Пауза",
    "Wait Until": "Ждать условие",
    "Verify": "Проверить",
    "Repeat": "Повторить",
    "Set Variable": "Задать переменную",
    "Log Message": "Записать в журнал",
    # ------------------------------------------------------ action describe
    "%s -> %s": "%s -> %s",
    "PRESS KEY %s": "НАЖАТЬ КЛАВИШУ %s",
    "PRESS KEY %s x%s": "НАЖАТЬ КЛАВИШУ %s x%s",
    "HOTKEY %s": "ГОРЯЧИЕ КЛАВИШИ %s",
    "TYPE TEXT from variable '%s'": "ВВЕСТИ ТЕКСТ из переменной «%s»",
    "TYPE VARIABLE {{%s}}": "ВВЕСТИ ПЕРЕМЕННУЮ {{%s}}",
    "TYPE TEXT (%s)": "ВВЕСТИ ТЕКСТ (%s)",
    "TYPE TEXT '%s'": "ВВЕСТИ ТЕКСТ «%s»",
    "REPEAT %sx (%s action(s))": "ПОВТОРИТЬ %s раз (действий: %s)",
    "SET VARIABLE %s += %s": "ЗАДАТЬ ПЕРЕМЕННУЮ %s += %s",
    "SET VARIABLE %s = %r (%s)": "ЗАДАТЬ ПЕРЕМЕННУЮ %s = %r (%s)",
    "LOG '%s'": "ЗАПИСАТЬ «%s»",
    # ------------------------------------------------------ target describe
    "window (%.3f,%.3f)": "окно (%.3f,%.3f)",
    "window pixel (%s,%s)": "пиксель окна (%s,%s)",
    "last match": "последнее совпадение",
    "image '%s'": "изображение «%s»",
    "text '%s'": "текст «%s»",
    "element of state '%s'": "элемент состояния «%s»",
    "current": "текущее",
    "current pointer": "текущая позиция мыши",
    "window position": "позиция в окне",
    "current pointer position": "текущая позиция мыши",
    "reference '%s'": "эталон «%s»",
    # ---------------------------------------------------------- state/report
    "full screen": "весь экран",
    "ROI %.2fx%.2f at (%.2f,%.2f)": "область %.2fx%.2f в (%.2f,%.2f)",
    "%s (>= %.2f, %s)": "%s (>= %.2f, %s)",
    "confidence >= %.2f": "уверенность >= %.2f",
    "%s reference image(s)": "эталонных изображений: %s",
    "%s action(s)": "действий: %s",
    "expect %s": "ожидается %s",
    "fallback %s": "откат %s",
    "UNKNOWN (best guess %s at %.2f)": "НЕИЗВЕСТНО (лучшее совпадение %s: %.2f)",
    "%s, confidence=%.2f": "%s, уверенность=%.2f",
    " (ambiguous with %s at %.2f)": " (неоднозначно с %s: %.2f)",
    "%s cycle(s) in %.1fs, %s success, %s failed, %s retries, %s unknown":
        "циклов: %s за %.1f с, успешно: %s, ошибок: %s, повторов: %s, неизвестно: %s",
    "expected %s, observed %s": "ожидалось %s, обнаружено %s",
    "expected %s confirmed": "ожидаемое %s подтверждено",
    "timeout": "таймаут",
    "nothing to verify": "нечего проверять",
    "no condition": "без условия",
    "ambiguous match with %s": "неоднозначное совпадение с %s",
    "%s: %s state(s), %s workflow node(s), %s reference image(s)":
        "%s: состояний %s, шагов сценария %s, эталонных изображений %s",
    # --------------------------------------------------------------- the log
    "Ready. F8 = start/pause, F9 = emergency stop":
        "Готово. F8 — старт/пауза, F9 — аварийный стоп",
    "New project created": "Создан новый проект",
    "Found %s LDPlayer window(s)": "Найдено окон LDPlayer: %s",
    "No LDPlayer window found. Start an instance, or use 'Screen region...'":
        "Окна LDPlayer не найдены. Запустите эмулятор или нажмите «Область экрана...»",
    "LDPlayer selected: %s": "Выбран LDPlayer: %s",
    "Using the screen region %s": "Используется область экрана %s",
    "Window %s: %s": "Окно %s: %s",
    "Analysis: %s": "Анализ: %s",
    "State added: %s": "Добавлено состояние: %s",
    "Step added: %s": "Добавлен шаг: %s",
    "Engine settings updated": "Настройки движка обновлены",
    "Log saved (text only)": "Журнал сохранён (только текст)",
    "Report: %s": "Итог: %s",
    "Engine error: %s": "Ошибка движка: %s",
    "GUI update failed: %s": "Не удалось обновить интерфейс: %s",
    "Language changed to %s": "Язык интерфейса: %s",
    "Engine started": "Движок запущен",
    "Engine paused (F8 to resume)": "Пауза (F8 — продолжить)",
    "Engine resumed": "Продолжаем",
    "EMERGENCY STOP (%s)": "АВАРИЙНЫЙ СТОП (%s)",
    "Engine idle (%s)": "Движок остановлен (%s)",
    "Action cancelled: %s": "Действие отменено: %s",
    "Cooldown: waiting %.2fs before repeating '%s'":
        "Задержка: ждём %.2f с перед повтором «%s»",
    "Rate limit reached (%s actions/min), waiting %.1fs":
        "Достигнут предел (%s действий/мин), ждём %.1f с",
    "Analyzing screen": "Анализируем экран",
    "State detected: %s, confidence=%.2f": "Обнаружено состояние: %s, уверенность=%.2f",
    "State detected: %s": "Обнаружено состояние: %s",
    "Unknown state (%s)": "Состояние не распознано (%s)",
    "Executing action %s/%s: %s": "Выполняем действие %s/%s: %s",
    "Action failed: %s": "Действие не выполнено: %s",
    "Action blocked: %s": "Действие заблокировано: %s",
    "Node blocked: %s": "Шаг заблокирован: %s",
    "Verification started": "Начата проверка",
    "Verification: SUCCESS": "Проверка: УСПЕХ",
    "Verification: SUCCESS (%s)": "Проверка: УСПЕХ (%s)",
    "Verification: FAILED (%s)": "Проверка: ОШИБКА (%s)",
    "Verification: ambiguous (%s)": "Проверка: неоднозначно (%s)",
    "Verification failed, running the FAILED branch":
        "Проверка не прошла, идём по ветке ОШИБКА",
    "SUCCESS": "УСПЕХ",
    "Retry %s/%s": "Повтор %s/%s",
    "Next state: %s": "Следующее состояние: %s",
    "Terminal state %s reached": "Достигнуто конечное состояние %s",
    "State %s failed and has no fallback": "Состояние %s не сработало, откат не задан",
    "Fallback: STOP": "Откат: СТОП",
    "Fallback: running state %s": "Откат: выполняем состояние %s",
    "Fallback state '%s' does not exist": "Состояние откáта «%s» не существует",
    "Recognition is ambiguous (%s vs %s): no action performed":
        "Распознавание неоднозначно (%s против %s): действие не выполнено",
    "Reference image '%s' is not available": "Эталонное изображение «%s» недоступно",
    "State '%s' could not be evaluated: %s": "Не удалось проверить состояние «%s»: %s",
    "State '%s' is not defined": "Состояние «%s» не определено",
    "Waiting for state %s (timeout %.1fs)": "Ждём состояние %s (таймаут %.1f с)",
    "Expected %s but found %s (confidence=%.2f)":
        "Ожидалось %s, а найдено %s (уверенность=%.2f)",
    "Timeout while waiting for state %s": "Таймаут ожидания состояния %s",
    "Running the UNKNOWN state handler": "Выполняем обработчик состояния UNKNOWN",
    "Stopping: %s": "Остановка: %s",
    "Run finished: %s": "Прогон завершён: %s",
    "Run aborted: %s": "Прогон прерван: %s",
    "Reason: %s": "Причина: %s",
    "STOP: %s": "СТОП: %s",
    "Waiting %.2fs": "Ждём %.2f с",
    "Wait condition satisfied after %s check(s)": "Условие выполнено после проверок: %s",
    "Wait condition satisfied (%s)": "Условие ожидания выполнено (%s)",
    "WAIT UNTIL timed out after %.1fs": "Таймаут ожидания условия: %.1f с",
    "WAIT UNTIL timed out": "Таймаут ожидания условия",
    "WAIT UNTIL %s (timeout %.1fs)": "ЖДАТЬ ПОКА %s (таймаут %.1f с)",
    "Repeat iteration %s/%s": "Повтор %s/%s",
    "Loop iteration %s/%s": "Итерация цикла %s/%s",
    "LOOP stopped at the iteration limit (%s)": "Цикл остановлен на пределе итераций (%s)",
    "RETRY exhausted after %s attempt(s)": "Повторы исчерпаны после попыток: %s",
    "Workflow cycle %s": "Цикл сценария %s",
    "Cycle %s finished with a failure: %s": "Цикл %s завершился ошибкой: %s",
    "IF %s -> %s": "ЕСЛИ %s -> %s",
    "ELSE IF %s -> %s": "ИНАЧЕ ЕСЛИ %s -> %s",
    "ELSE branch": "Ветка ИНАЧЕ",
    "YES": "ДА",
    "NO": "НЕТ",
    "%s at window (%s,%s) [%s%s]": "%s в окне (%s,%s) [%s%s]",
    "Click": "Клик",
    "Double click": "Двойной клик",
    "Triple click": "Тройной клик",
    "%sx click": "%s кликов",
    "Drag from window (%s,%s) to (%s,%s) [%s]":
        "Перетаскивание в окне из (%s,%s) в (%s,%s) [%s]",
    "Drag cancelled: %s": "Перетаскивание отменено: %s",
    "Mouse moved to client (%s,%s)": "Мышь переведена в (%s,%s)",
    "Pointer input disabled (%s); running in dry-run mode":
        "Ввод мышью недоступен (%s); работаем в пробном режиме",
    "Keyboard input disabled (%s); running in dry-run mode":
        "Ввод с клавиатуры недоступен (%s); работаем в пробном режиме",
    "Key press: %s%s": "Нажата клавиша: %s%s",
    "Hotkey: %s": "Горячие клавиши: %s",
    "Typed text (%s)": "Введён текст (%s)",
    "%s chars": "символов: %s",
    "Could not type a non-ASCII character (install pyperclip)":
        "Не удалось ввести не-ASCII символ (установите pyperclip)",
    "Global hotkeys active: %s": "Глобальные горячие клавиши активны: %s",
    "Global hotkeys need Windows; using window-level bindings":
        "Глобальные горячие клавиши работают только в Windows; используем клавиши окна",
    "Hotkey '%s' cannot be registered globally":
        "Клавишу «%s» нельзя зарегистрировать глобально",
    "Windows refused to register the %s hotkey": "Windows не дала зарегистрировать %s",
    "Hotkey handler failed: %s": "Обработчик горячей клавиши упал: %s",
    "Window moved: (%s,%s) -> (%s,%s)": "Окно перемещено: (%s,%s) -> (%s,%s)",
    "Window resized: %sx%s -> %sx%s (coordinates rescaled)":
        "Размер окна изменён: %sx%s -> %sx%s (координаты пересчитаны)",
    "PrintWindow returned a black frame; used a screen copy instead":
        "PrintWindow вернул чёрный кадр; снята копия области экрана",
    "Captured frame is black (mean=%.2f); PrintWindow often fails on LDPlayer":
        "Кадр чёрный (яркость=%.2f); PrintWindow на LDPlayer часто так делает",
    "mss fallback after a black frame failed: %s":
        "Запасной захват mss после чёрного кадра не удался: %s",
    "Captured frame is black (mean=%.2f). Uncover the LDPlayer window "
    "and try capture backend 'mss' in engine settings":
        "Кадр чёрный (яркость=%.2f). Откройте окно LDPlayer и в настройках "
        "движка поставьте захват mss",
    "The selected LDPlayer window has disappeared": "Выбранное окно LDPlayer исчезло",
    "Project saved: %s": "Проект сохранён: %s",
    "Project loaded: %s (%s state(s), %s reference image(s))":
        "Проект загружен: %s (состояний: %s, эталонов: %s)",
    "Reference image '%s' added (%sx%s)": "Добавлен эталон «%s» (%sx%s)",
    "Reference image '%s' could not be loaded: %s":
        "Не удалось загрузить эталон «%s»: %s",
    "Missing reference image files: %s": "Отсутствуют файлы эталонов: %s",
    "Project warning: %s": "Замечание по проекту: %s",
    "Loading PaddleOCR (lang=%s), first run may take a while":
        "Загружаем PaddleOCR (язык=%s), первый запуск может занять время",
    "PaddleOCR ready": "PaddleOCR готов",
    "PaddleOCR unavailable: %s": "PaddleOCR недоступен: %s",
    "PaddleOCR is not installed, using Tesseract": "PaddleOCR не установлен, используем Tesseract",
    "Tesseract unavailable: %s": "Tesseract недоступен: %s",
    "No OCR engine installed: text and number conditions will not match":
        "OCR не установлен: условия по тексту и числам не будут срабатывать",
    "OCR failed: %s": "Ошибка OCR: %s",
    "Invalid text pattern: %s": "Неверный шаблон текста: %s",
    "Recording started (press %s to stop)": "Запись начата (%s — остановить)",
    "Recording finished: %s step(s)": "Запись завершена, шагов: %s",
    "%s event(s) outside the emulator window were ignored":
        "Событий вне окна эмулятора пропущено: %s",
    "%s click(s) anchored to a reference image":
        "Кликов привязано к эталонным изображениям: %s",
    "The click could not be anchored to an image: %s":
        "Не удалось привязать клик к изображению: %s",
    "Recording needs the 'pynput' package (pip install pynput)":
        "Для записи нужен пакет «pynput» (pip install pynput)",
    "Input listener active": "Слежение за вводом включено",
    "%s starting (frames are analysed in RAM and never stored)":
        "%s запускается (кадры анализируются в памяти и не сохраняются)",
    "Dry run: recognition runs, but no click or keystroke is sent":
        "Пробный прогон: распознавание работает, ввод не отправляется",
    "Capture failed: %s": "Не удалось захватить экран: %s",
    # ------------------------------------------------------------ command line
    "%s LDPlayer window(s):": "Найдено окон LDPlayer: %s",
    "No LDPlayer window found.": "Окна LDPlayer не найдены.",
    "Window discovery requires Windows; use --region on other systems.":
        "Поиск окон работает в Windows; в других системах используйте --region.",
    "Result: %s": "Итог: %s",
    "Stopped because: %s": "Причина остановки: %s",
    "Window: %s %sx%s": "Окно: %s %sx%s",
    "Detected state: %s": "Обнаруженное состояние: %s",
    "Scores:": "Оценки:",
    "No state defines a detection rule yet.":
        "Ни у одного состояния ещё нет правила распознавания.",
    "Project: %s": "Проект: %s",
    "States:": "Состояния:",
    "Nothing to do. Use --run, --analyze, --print-workflow or --list-instances.":
        "Нечего делать. Используйте --run, --analyze, --print-workflow или --list-instances.",
    "WARNING, unexpected image artefacts found:":
        "ВНИМАНИЕ: найдены неожидаемые файлы изображений:",
    # ------------------------------------------------------- recorded steps
    "%s at %s": "%s в %s",
    "%s on the recognised element %s": "%s по распознанному элементу %s",
    "Right click": "Правый клик",
    "Drag %s -> %s": "Перетаскивание %s -> %s",
    "Move pointer to %s": "Подвести мышь к %s",
    "Hotkey %s": "Горячие клавиши %s",
    "Key %s": "Клавиша %s",
    "Type text (%s characters)": "Ввод текста (%s символов)",
    "Wait %.2fs": "Пауза %.2f с",
    # -------------------------------------------------------- example project
    "Main screen the test starts from": "Основной экран, с которого начинается тест",
    "Error message screen": "Экран с сообщением об ошибке",
    "Success screen": "Экран успешного завершения",
    "Nothing recognised: wait and analyse again":
        "Ничего не распознано: ждём и анализируем снова",
    "Example scenario": "Пример сценария",
    "LDPlayer example": "Пример для LDPlayer",
    "LDPlayer sequential macros": "Последовательные макросы LDPlayer",
    "Sequential macros": "Последовательные макросы",
    "Record the VK authorisation": "Запишите авторизацию через VK",
    "Record the steps after a successful login": "Запишите шаги после успешного входа",
    "Optional reset after AUTH_ERROR": "Необязательный сброс после AUTH_ERROR",
    "Unsuccessful authorisation screen": "Экран неудачной авторизации",
    "Screen after a successful authorisation": "Экран после успешной авторизации",
    "MACRO_2 failed": "MACRO_2 завершился ошибкой",
    "MACRO_2 succeeded": "MACRO_2 завершился успешно",
    "there is another test row": "есть ещё тестовая запись",
    "FAIL (%s)": "СБОЙ (%s)",
    "LOAD TEST DATA": "ЗАГРУЗИТЬ ТЕСТОВЫЕ ДАННЫЕ",
    "File: one line email|password or email:password. Passwords stay in RAM.":
        "Файл: одна строка email|password или email:password. Пароли остаются в ОЗУ.",
    "VERIFY": "ПРОВЕРКА",
    "RESET / START": "СБРОС / СТАРТ",
    "Capture Success": "Захватить успех",
    "Capture Error": "Захватить ошибку",
    "Capture start screen": "Захватить стартовый экран",
    "Capture manual / bot-check": "Захватить ручное подтверждение",
    "Bot-check is never solved. The run waits until you press Continue.":
        "Защитные экраны программа не обходит. Сценарий ждёт, пока вы нажмёте «Продолжить».",
    "INVALID": "НЕКОРРЕКТНЫЕ",
    "Line": "Строка",
    "Continue": "Продолжить",
    "Current record: %s / %s": "Текущая запись: %s / %s",
    "Success: %s": "Успешно: %s",
    "Failed: %s": "Ошибок: %s",
    "Invalid: %s": "Некорректных: %s",
    "Imported %s record(s), %s invalid line(s) from %s":
        "Импортировано записей: %s, некорректных строк: %s (%s)",
    "MANUAL ACTION REQUIRED": "НУЖНО РУЧНОЕ ДЕЙСТВИЕ",
    "LOAD RECORD": "ЗАГРУЗИТЬ ЗАПИСЬ",
    "NEXT RECORD": "СЛЕДУЮЩАЯ ЗАПИСЬ",
    "RECORD RESULT (%s)": "ИТОГ ЗАПИСИ (%s)",
    "WAIT FOR START STATE": "ЖДАТЬ СТАРТОВЫЙ ЭКРАН",
    "Four-stage macros": "Четыре этапа макросов",
    "Record stage 1. Type {{EMAIL}} in the email field.":
        "Запишите этап 1. В поле email введите {{EMAIL}}.",
    "Record stage 2. Bot-checks wait for you; they are not solved.":
        "Запишите этап 2. Защитные экраны ждут вас; программа их не решает.",
    "Record stage 3. Type {{PASSWORD}} where the password belongs.":
        "Запишите этап 3. В поле пароля введите {{PASSWORD}}.",
    "Record stage 4, after the previous verifies succeeded.":
        "Запишите этап 4 после успешных проверок предыдущих этапов.",
    "Optional reset between records": "Необязательный сброс между записями",
    "Screen that means the workflow is back at the start":
        "Экран, с которого сценарий начинается снова",
    "Manual confirmation / bot-check — wait, do not solve":
        "Ручное подтверждение / bot-check — ждать, не обходить",
    "VERIFY_%s succeeded": "VERIFY_%s успешен",
    "VERIFY_%s failed": "VERIFY_%s с ошибкой",
    "PASSWORD is not used in this macro": "PASSWORD на этом этапе не используется",
    "No test data row; macros will use recorded text":
        "Нет тестовой записи; макросы используют записанный текст",
    "Record #%s loaded": "Запись №%s загружена",
    "Loading next record": "Загрузка следующей записи",
    "RECORD #%s SUCCESS": "ЗАПИСЬ №%s УСПЕХ",
    "RECORD #%s %s": "ЗАПИСЬ №%s %s",
    "WORKFLOW SUCCESS": "СЦЕНАРИЙ УСПЕШНО ЗАВЕРШЁН",
    "Start state detected": "Стартовый экран обнаружен",
    "Start state not detected, continuing": "Стартовый экран не найден, продолжаем",
    "Manual action confirmed, continuing": "Ручное действие подтверждено, продолжаем",
    "Manual wait skipped (test)": "Ожидание ручного действия пропущено (тест)",
    "NEXT TEST DATA": "СЛЕДУЮЩАЯ ТЕСТОВАЯ ЗАПИСЬ",
    "This macro has no steps. Press Record first.":
        "В этом макросе ещё нет шагов. Сначала нажмите «Запись».",
    "(empty)": "(пусто)",
    "Save the project before capturing a result state.":
        "Сначала сохраните проект, затем захватывайте эталон состояния.",
    "Region too large": "Область слишком большая",
    "The selection covers most of the screen. A small unique element "
    "(error text, button) works better. Use it anyway?":
        "Выделение занимает почти весь экран. Лучше выбрать маленький характерный "
        "элемент (текст ошибки, кнопку). Использовать всё равно?",
    "State: %s\nDetected: %s\nConfidence: %.2f\nCoordinates: %s":
        "Состояние: %s\nОбнаружено: %s\nУверенность: %.2f\nКоординаты: %s",
    "Recorded %s action(s) into %s": "Записано действий: %s в макрос %s",
    "Bound %s typed field(s) to test data variables":
        "Привязано полей ввода к тестовым данным: %s",
    "Starting %s (test)": "Запуск %s (проверка)",
    "Saved result state %s (confidence %.2f)":
        "Эталон состояния %s сохранён (уверенность %.2f)",
    "TEST %s | Detected: %s | Confidence: %.2f | Coordinates: %s":
        "ТЕСТ %s | Обнаружено: %s | Уверенность: %.2f | Координаты: %s",
    "STEP: %s | state=%s (%.2f) | next: %s | F10 continue, F9 stop":
        "ШАГ: %s | состояние=%s (%.2f) | дальше: %s | F10 продолжить, F9 стоп",
    "Macro '%s' is not defined": "Макрос «%s» не задан",
    "No test data row; AUTH_VK will use recorded text":
        "Нет тестовой записи; AUTH_VK использует записанный текст",
    "Loading test data %s": "Загрузка тестовых данных %s",
    "Loading next test data": "Загрузка следующей тестовой записи",
    "No further test data": "Больше тестовых записей нет",
}

TRANSLATIONS: dict[str, dict[str, str]] = {"ru": RU, "en": {}}


def available_languages() -> list[tuple[str, str]]:
    """``(code, label)`` pairs for the language picker."""
    return [(code, LANGUAGE_LABELS[code]) for code in ("ru", "en")]


def language_label(code: str) -> str:
    return LANGUAGE_LABELS.get(code, code)


def language_code(label: str) -> str:
    for code, name in LANGUAGE_LABELS.items():
        if name == label:
            return code
    return DEFAULT_LANGUAGE


def get_language() -> str:
    return _language


def set_language(code: str) -> str:
    global _language
    code = (code or DEFAULT_LANGUAGE).lower()
    if code not in TRANSLATIONS:
        code = DEFAULT_LANGUAGE
    _language = code
    return _language


def tr(text: str) -> str:
    """Translate one string; unknown strings are returned unchanged."""
    if not isinstance(text, str) or _language == "en":
        return text
    return TRANSLATIONS.get(_language, {}).get(text, text)


def placeholders(text: str) -> list[str]:
    return [match.group("type") for match in PLACEHOLDER.finditer(text) if match.group("type") != "%"]


def validate_translations(languages: Iterable[str] = ("ru",)) -> list[str]:
    """Report translations whose format placeholders differ from the original."""
    problems: list[str] = []
    for code in languages:
        for source, target in TRANSLATIONS.get(code, {}).items():
            if placeholders(source) != placeholders(target):
                problems.append(
                    f"{code}: {source!r} has {placeholders(source)} "
                    f"but the translation has {placeholders(target)}"
                )
    return problems
