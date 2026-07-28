# UI Templates

Place PNG screenshots captured from your emulator at **1280×720** here.

## Required templates

| File | Description |
|------|-------------|
| `google_sign_in.png` | "Sign in with Google" on first launch |
| `google_email.png` | Email input field highlight |
| `google_next.png` | Next button on Google login |
| `google_password.png` | Password field |
| `google_login_btn.png` | Final Google sign-in confirm |
| `main_play.png` | Main menu play button (post-login) |
| `settings.png` | Gear / settings icon |
| `twitch_bind.png` | "Bind Twitch" in settings |
| `twitch_authorize.png` | Twitch OAuth authorize button |
| `inventory.png` | Inventory tab/button |
| `market_tab.png` | Market price tab on item detail |
| `sell.png` | Sell / list on market button |
| `confirm_sell.png` | Confirm listing dialog |
| `logout.png` | Logout in settings |
| `account_blocked.png` | Ban / blocked screen (for skip detection) |
| `popup_close.png` | Generic X close on popups |

## How to capture

1. Take full screenshot from emulator (or `adb exec-out screencap -p > screen.png`).
2. Crop each button:

```bash
python capture_template.py screen.png google_sign_in 400 500 900 580
```

3. Tune `match_threshold` in `config.py` if false positives occur (default `0.78`).
