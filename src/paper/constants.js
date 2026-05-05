// Polymarket fee model
export const FEE_RATE_BPS = 100;        // 1% — current Polymarket rate
export const FEE_MIN = 0.0001;          // floor when computed fee > 0

// Resolution thresholds (float-safe, NOT === 1.0 / === 0.0)
export const WIN_PRICE_THRESHOLD = 0.99;
export const LOSS_PRICE_THRESHOLD = 0.01;

// Ranking
export const RANK_MIN_RESOLVED = 5;     // below threshold → UNRANKED badge

// Slippage tier boundaries (mirror GodEye)
export const SLIP_BOUNDARY_HIGH = 0.40;
export const SLIP_BOUNDARY_LOW = 0.18;
export const DEFAULT_SLIPPAGE_TOLERANCE = {
  above40c: 4,        // 4% max slippage when token price >= 40c
  between18_40c: 10,  // 10% when 18c <= price < 40c
  below18c: 25,       // 25% when price < 18c
};

// Polling cadence
export const POLL_TRADES_MS = 30_000;
export const POLL_RESOLUTION_MS = 60_000;
export const SCHEDULER_TICK_MS = 10_000;
export const POLL_JITTER_MS = 5_000;
export const ACTIVITY_PAGE_LIMIT = 50;

// IndexedDB
export const DB_NAME = 'polyhub_paper_trader';
export const DB_VERSION = 1;
export const STORES = {
  REGISTRY: 'pt_registry',
  ACCOUNTS: 'pt_accounts',
  TRADES: 'pt_trades',
  POSITIONS: 'pt_positions',
  MARKET_CACHE: 'pt_market_cache',
};

// Polymarket API endpoints
export const API = {
  ACTIVITY: 'https://data-api.polymarket.com/activity',
  CLOB_BOOK: 'https://clob.polymarket.com/book',
  GAMMA_MARKETS: 'https://gamma-api.polymarket.com/markets',
  POSITIONS_PROXY: '/api/positions',
  CLOB_PROXY: '/api/clob',
};
