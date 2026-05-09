"""Constants ported from src/paper/constants.js. Keep in sync with the JS side."""

# Polymarket fee model
FEE_RATE_BPS = 100
FEE_MIN = 0.0001

# Resolution thresholds (float-safe)
WIN_PRICE_THRESHOLD = 0.99
LOSS_PRICE_THRESHOLD = 0.01

# Ranking
RANK_MIN_RESOLVED = 5

# Slippage tier boundaries (mirror GodEye)
SLIP_BOUNDARY_HIGH = 0.40
SLIP_BOUNDARY_LOW = 0.18
DEFAULT_SLIPPAGE_TOLERANCE = {
    "above40c": 4,
    "between18_40c": 10,
    "below18c": 25,
}

# Polling cadence (seconds)
POLL_TRADES_SEC = 30
POLL_RESOLUTION_SEC = 60
SCHEDULER_TICK_SEC = 10
POLL_JITTER_SEC = 5
ACTIVITY_PAGE_LIMIT = 50

# Polymarket API endpoints (worker uses direct URLs — no CORS issues server-side)
ACTIVITY_URL = "https://data-api.polymarket.com/activity"
CLOB_BOOK_URL = "https://clob.polymarket.com/book"
GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
POSITIONS_URL_TEMPLATE = "https://data-api.polymarket.com/positions"
CLOSED_POSITIONS_URL_TEMPLATE = "https://data-api.polymarket.com/closed-positions"
