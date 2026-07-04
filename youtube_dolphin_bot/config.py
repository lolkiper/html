"""
Configuration settings for the YouTube Dolphin Bot.
"""

# Dolphin Anty local API (must be running on your PC)
DOLPHIN_API_BASE = "http://localhost:3001/v1.0"

# Timeout settings (seconds)
PAGE_LOAD_TIMEOUT = 30
ELEMENT_WAIT_TIMEOUT = 20
ACTION_DELAY = 2          # pause between UI actions
LOGIN_WAIT = 5            # pause after submitting password

# Dolphin profile defaults
PROFILE_OS = "windows"    # windows / macos / linux
PROFILE_SCREEN = "1920x1080"
DEFAULT_TAGS = ["youtube"]

# Output
LOG_FILE = "bot.log"
RESULTS_FILE = "results.csv"
