import { cfg } from "../config.js";

type CacheEntry = {
  winrate: number;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * How many recent trades we pull from data-api.polymarket.com.
 *
 * IMPORTANT LIMITATION: The data API returns trades in reverse-chronological
 * order. At high market activity (~300+ trades/min across all markets),
 * 5,000 trades may only cover the last 10–30 minutes of history — meaning
 * "historical winrate" is actually very short-term recency bias.
 *
 * Increasing this value gives more history but costs more bandwidth and
 * processing time each cache refresh. 10,000 is a reasonable upper bound
 * before the API starts rate-limiting. For genuine statistical significance
 * you'd want 50+ resolved markets per wallet; at 5k trades you may only
 * see 5–15 markets per active wallet, which is why MIN_MARKETS_FOR_CONFIDENCE
 * is set conservatively.
 */
const TRADE_LIMIT = 5000;

/**
 * Minimum number of resolved markets a wallet must appear in before we trust
 * its winrate. Below this, we return 0.5 (coin-flip default) so the whale
 * filter won't count wallets with a lucky 1-for-1 record as high-confidence.
 */
const MIN_MARKETS_FOR_CONFIDENCE = 5;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function normalizeWallet(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const w = raw.trim().toLowerCase();
  if (!w.startsWith("0x") || w.length < 10) return null;
  return w;
}

type TradeRow = {
  proxyWallet?: string;
  eventSlug?: string;
  outcome?: string;
  side?: "BUY" | "SELL";
  size?: number;
  price?: number;
  timestamp?: number;
};

type MarketAgg = {
  yesEndPrices: Array<{ ts: number; price: number }>;
  walletYesNotional: Map<string, number>;
};

function parse5mStartFromSlug(slug: string): number | null {
  const m = slug.match(/btc-updown-5m-(\d{9,12})/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function signedYesNotional(t: TradeRow): number {
  const outcome = (t.outcome || "").toLowerCase();
  const side = (t.side || "BUY").toUpperCase();
  const notional = Math.max(0, Number(t.size ?? 0) * Number(t.price ?? 0));
  if (!notional) return 0;
  const isYesOutcome = outcome === "up" || outcome === "yes";
  if (isYesOutcome) return side === "BUY" ? notional : -notional;
  return side === "BUY" ? -notional : notional;
}

async function fetchRecentTrades(signal: AbortSignal): Promise<TradeRow[]> {
  const res = await fetch(`https://data-api.polymarket.com/trades?limit=${TRADE_LIMIT}`, { signal });
  if (!res.ok) return [];
  return (await res.json()) as TradeRow[];
}

function computeLocalWinrates(trades: TradeRow[], targetWallets: Set<string>): Map<string, number> {
  const byMarket = new Map<string, MarketAgg>();
  for (const t of trades) {
    const slug = (t.eventSlug || "").toLowerCase();
    if (!slug.startsWith("btc-updown-5m-")) continue;
    const wallet = normalizeWallet(t.proxyWallet);
    if (!wallet || !targetWallets.has(wallet)) continue;

    const agg = byMarket.get(slug) || { yesEndPrices: [], walletYesNotional: new Map<string, number>() };
    const yesSigned = signedYesNotional(t);
    if (yesSigned !== 0) {
      agg.walletYesNotional.set(wallet, (agg.walletYesNotional.get(wallet) ?? 0) + yesSigned);
    }
    const outcome = (t.outcome || "").toLowerCase();
    if (outcome === "up" || outcome === "yes") {
      const ts = Number(t.timestamp ?? 0);
      const price = Number(t.price ?? NaN);
      if (ts > 0 && Number.isFinite(price)) agg.yesEndPrices.push({ ts, price });
    }
    byMarket.set(slug, agg);
  }

  const wins = new Map<string, number>();
  const totals = new Map<string, number>();

  for (const [slug, agg] of byMarket.entries()) {
    const startSec = parse5mStartFromSlug(slug);
    if (!startSec) continue;
    const endSec = startSec + 300;
    const endWindow = agg.yesEndPrices
      .filter((x) => x.ts >= (endSec - 30) * 1000 && x.ts <= endSec * 1000 + 10000)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5);
    if (!endWindow.length) continue;
    const endMean = endWindow.reduce((s, x) => s + x.price, 0) / endWindow.length;
    const finalYes = endMean >= 0.5;

    for (const [wallet, netYes] of agg.walletYesNotional.entries()) {
      if (Math.abs(netYes) < cfg.whaleMinNotional) continue;
      const walletBetYes = netYes > 0;
      totals.set(wallet, (totals.get(wallet) ?? 0) + 1);
      if (walletBetYes === finalYes) wins.set(wallet, (wins.get(wallet) ?? 0) + 1);
    }
  }

  const out = new Map<string, number>();
  for (const wallet of targetWallets) {
    const total = totals.get(wallet) ?? 0;
    const win = wins.get(wallet) ?? 0;
    if (total < MIN_MARKETS_FOR_CONFIDENCE) {
      out.set(wallet, 0.5);
      continue;
    }
    out.set(wallet, clamp01(win / total));
  }
  return out;
}

export async function getWalletWinrates(wallets: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const ttlMs = cfg.walletWinrateCacheTtlSec * 1000;
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))];

  const result = new Map<string, number>();
  const missing: string[] = [];

  for (const w of unique) {
    const hit = cache.get(w);
    if (hit && hit.expiresAt > now) result.set(w, hit.winrate);
    else missing.push(w);
  }
  if (!missing.length) return result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.walletWinrateTimeoutMs);
  try {
    const trades = await fetchRecentTrades(controller.signal);
    const parsed = computeLocalWinrates(trades, new Set(missing));
    const expiresAt = Date.now() + ttlMs;

    for (const wallet of missing) {
      const wr = parsed.get(wallet);
      if (wr == null) continue;
      cache.set(wallet, { winrate: wr, expiresAt });
      result.set(wallet, wr);
    }
    return result;
  } catch {
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
