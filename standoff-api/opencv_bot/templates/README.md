# Шаблоны для OpenCV (PNG, 1280×720)

Сделай скриншоты кнопок в LDPlayer и обрежь маленькие фрагменты (~50–200 px).
Положи файлы сюда с именами из `config.json` → `TEMPLATES`.

| Файл | Что вырезать |
|------|----------------|
| `standoff_icon.png` | Иконка Standoff 2 на рабочем столе |
| `google_sign_in.png` | Кнопка «Вход с помощью Google» в игре |
| `google_next.png` | Кнопка «Далее» в Google Auth |
| `google_agree.png` | «Принимаю» / «I agree» |
| `lobby_play.png` | Кнопка PLAY / ИГРАТЬ в лобби |
| `inventory.png` | Иконка инвентаря |
| `case_item.png` | Иконка кейса в списке |
| `sell_button.png` | Кнопка «Продать» |
| `create_order.png` | «Создать заказ» / подтверждение |

**Без шаблонов** бот работает через координаты из `COORDS` в config.json и uiautomator fallback для Google.

## OCR (цена запроса)

Установи [Tesseract](https://github.com/tesseract-ocr/tesseract) и укажи путь в config:
```json
"OCR": {
  "order_price_roi": [420, 350, 860, 420],
  "tesseract_cmd": "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
}
```

Область `order_price_roi` — прямоугольник [x1,y1,x2,y2] вокруг текста «Цена запроса» на экране рынка.
