import "dotenv/config";

export const cfg = {
  // ── API endpoints ──────────────────────────────────────────────────────────
  polymarketRestBase: process.env.POLYMARKET_REST_BASE ?? "https://gamma-api.polymarket.com",
  binanceRestBase: process.env.BINANCE_REST_BASE ?? "https://fapi.binance.com",

  // ── OpenAI (optional) ──────────────────────────────────────────────────────
  // Leave OPENAI_API_KEY blank to skip the LLM scorer (llmBias will be 0).
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",

  // ── Trading mode ───────────────────────────────────────────────────────────
  // PAPER MODE (safe default): leave PRIVATE_KEY blank.
  //   The bot runs the full prediction loop and logs every signal but
  //   never touches the CLOB — no real orders, no real money.
  //
  // LIVE MODE: set PRIVATE_KEY to your Polymarket wallet's 64-char hex key.
  //   Real FOK buy orders are placed when confidence and timing gates pass.
  //   CLOB_API_KEY / CLOB_SECRET / CLOB_PASS_PHRASE are optional — if all
  //   three are omitted, API keys are derived automatically.
  clobApiUrl: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
  clobChainId: Number(process.env.CLOB_CHAIN_ID ?? 137),
  privateKey: process.env.PRIVATE_KEY,
  clobApiKey: process.env.CLOB_API_KEY,
  clobSecret: process.env.CLOB_SECRET,
  clobPassphrase: process.env.CLOB_PASS_PHRASE,

  // liveTradingEnabled is true only when a non-empty PRIVATE_KEY is present.
  // All order-placement code gates on this flag, so an empty key = paper mode.
  get liveTradingEnabled(): boolean {
    return Boolean(process.env.PRIVATE_KEY?.trim());
  },

  // ── Loop & position sizing ─────────────────────────────────────────────────
  loopSeconds: Number(process.env.LOOP_SECONDS ?? 15),
  maxPositionUsd: Number(process.env.MAX_POSITION_USD ?? 100),

  // ── Signal thresholds ──────────────────────────────────────────────────────
  edgeThreshold: Number(process.env.EDGE_THRESHOLD ?? 0.03),
  confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.8),

  // ── Exit settings ──────────────────────────────────────────────────────────
  // FORCE_EXIT_SECONDS: force-sell any open position this many seconds before
  // market settlement. Default 3s gives a small window to exit before the
  // final-second price flip. Minimum 1, maximum 119.
  forceExitSeconds: Number(process.env.FORCE_EXIT_SECONDS ?? 3),

  // CLOSE_AFTER_SECONDS: if > 0, proactively close any position after this
  // many seconds regardless of market timing — useful for cutting losses or
  // taking profits mid-market. Set to 0 (default) to rely only on force-exit.
  // Example: CLOSE_AFTER_SECONDS=120 closes positions 2 minutes after entry.
  closeAfterSeconds: Number(process.env.CLOSE_AFTER_SECONDS ?? 0),

  // ── Technical indicators ───────────────────────────────────────────────────
  emaFast: Number(process.env.EMA_FAST ?? 5),
  emaSlow: Number(process.env.EMA_SLOW ?? 13),
  rsiPeriod: Number(process.env.RSI_PERIOD ?? 14),

  // ── Whale / wallet scoring ─────────────────────────────────────────────────
  // WHALE_MIN_WINRATE: only wallets whose computed win-rate equals or exceeds
  // this threshold contribute to the whale pressure signal.
  whaleMinWinrate: Number(process.env.WHALE_MIN_WINRATE ?? 0.7),
  // WHALE_MIN_NOTIONAL: ignore wallets whose total trade size (USD) is below
  // this — filters out small noise trades.
  whaleMinNotional: Number(process.env.WHALE_MIN_NOTIONAL ?? 200),

  // Optional external win-rate API (leave blank to use local computation).
  walletWinrateApiUrl: process.env.WALLET_WINRATE_API_URL ?? "",
  walletWinrateApiKey: process.env.WALLET_WINRATE_API_KEY ?? "",
  walletWinrateTimeoutMs: Number(process.env.WALLET_WINRATE_TIMEOUT_MS ?? 3000),
  walletWinrateCacheTtlSec: Number(process.env.WALLET_WINRATE_CACHE_TTL_SEC ?? 600),
};
