import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { cfg } from "../config.js";

// --- Polymarket 2026 fee update ---
// Dynamic taker fees up to ~1.56% are now applied on FOK/FAK orders.
// Maker orders (GTC posted to the book) pay zero fees and earn rebates.
// We fetch the live fee rate per token before placing any order so the
// signed order payload includes the correct feeRateBps field.
// The CLOB client v5 fetches and caches this automatically in createOrder().

let _publicClient: ClobClient | null = null;
let _client: ClobClient | null = null;
let _clientInit: Promise<ClobClient> | null = null;

function getPublicClient(): ClobClient {
  if (!_publicClient) {
    _publicClient = new ClobClient(cfg.clobApiUrl, cfg.clobChainId);
  }
  return _publicClient;
}

function hasManualClobCreds(): boolean {
  const k = (cfg.clobApiKey ?? "").trim();
  const s = (cfg.clobSecret ?? "").trim();
  const p = (cfg.clobPassphrase ?? "").trim();
  return Boolean(k && s && p);
}

async function getClient(): Promise<ClobClient> {
  if (_client) return _client;
  if (_clientInit) return _clientInit;

  _clientInit = (async () => {
    if (!cfg.privateKey?.trim()) {
      throw new Error("Live trading needs PRIVATE_KEY in .env");
    }
    // ethers v5 Wallet satisfies the v5 clob-client signer interface
    // (duck-typed: needs _signTypedData + getAddress)
    const signer = new Wallet(cfg.privateKey.trim());

    let creds: ApiKeyCreds;
    if (hasManualClobCreds()) {
      creds = {
        key: cfg.clobApiKey!.trim(),
        secret: cfg.clobSecret!.trim(),
        passphrase: cfg.clobPassphrase!.trim()
      };
    } else {
      const l1 = new ClobClient(cfg.clobApiUrl, cfg.clobChainId, signer);
      creds = await l1.createOrDeriveApiKey();
    }

    _client = new ClobClient(cfg.clobApiUrl, cfg.clobChainId, signer, creds);
    return _client;
  })();

  try {
    return await _clientInit;
  } catch (e) {
    _clientInit = null;
    throw e;
  }
}

export type TokenIds = { yesTokenId: string; noTokenId: string };

export async function getTokenIdsForCondition(conditionId: string): Promise<TokenIds | null> {
  try {
    const client = getPublicClient();
    const market = await client.getMarket(conditionId);
    const tokens = (market as { tokens?: Array<{ outcome: string; token_id: string }> }).tokens;
    if (!tokens || tokens.length < 2) return null;
    const yesToken = tokens.find((t) => /yes|up/i.test(t.outcome ?? ""));
    const noToken = tokens.find((t) => /no|down/i.test(t.outcome ?? ""));
    if (!yesToken || !noToken) return null;
    return { yesTokenId: yesToken.token_id, noTokenId: noToken.token_id };
  } catch {
    return null;
  }
}

export type PlaceOrderParams = {
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  orderType?: "GTC" | "FOK" | "FAK";
};

export type PlaceOrderResult = {
  success: boolean;
  orderID?: string;
  status?: string;
  errorMsg?: string;
  /** Effective fee rate in basis points fetched from the CLOB (0 for GTC maker orders) */
  feeRateBps?: number;
};

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const client = await getClient();
  const { tokenId, side, size, price, orderType = "GTC" } = params;
  const sideEnum = side === "BUY" ? Side.BUY : Side.SELL;

  try {
    // Fetch live fee rate for this token so the signed payload is correct.
    // GTC maker orders resolve to 0 bps; FOK taker orders can be up to ~156 bps.
    let feeRateBps = 0;
    try {
      feeRateBps = await client.getFeeRateBps(tokenId);
    } catch {
      // non-fatal — clob-client will re-fetch inside createOrder() anyway
    }

    if (orderType === "GTC") {
      // GTC = maker order → zero fees, eligible for rebates
      const res = await client.createAndPostOrder(
        { tokenID: tokenId, price, size, side: sideEnum, feeRateBps },
        undefined,
        OrderType.GTC
      );
      return {
        success: res.success ?? true,
        orderID: res.orderID,
        status: res.status,
        feeRateBps: 0
      };
    }

    // FOK / FAK taker orders — include live fee rate in the signed payload
    const marketType = orderType === "FAK" ? OrderType.FAK : OrderType.FOK;
    const marketOrder = await client.createAndPostMarketOrder(
      { tokenID: tokenId, side: sideEnum, amount: size, price, feeRateBps },
      undefined,
      marketType
    );
    return {
      success: marketOrder.success ?? true,
      orderID: marketOrder.orderID,
      status: marketOrder.status,
      feeRateBps
    };
  } catch (e: unknown) {
    const err = e as Error;
    return {
      success: false,
      errorMsg: err.message ?? String(e)
    };
  }
}

export async function buy(
  tokenId: string,
  amountUsd: number,
  priceLimit: number
): Promise<PlaceOrderResult> {
  return placeOrder({
    tokenId,
    side: "BUY",
    size: amountUsd,
    price: priceLimit,
    orderType: "FOK"
  });
}

/**
 * Sell shares with a realistic price floor.
 *
 * FIX: The original code used priceLimit=0.01 on a FOK order. On a FOK,
 * if no buyer exists at that exact price the order is *cancelled* immediately
 * and you stay in the position through settlement — a silent financial risk.
 *
 * Strategy: try FOK at the supplied priceLimit first. If that fails (no fill),
 * fall back to a GTC limit sell at the same price so the order rests on the
 * book for any remaining seconds. Near expiry even a $0.02 bid exists because
 * the winner token resolves to $1.00, so resting orders get filled quickly.
 */
export async function sell(
  tokenId: string,
  sizeShares: number,
  priceLimit: number
): Promise<PlaceOrderResult> {
  // Clamp floor to 0.02 — 0.01 is below the minimum tick on most markets
  const safePrice = Math.max(0.02, priceLimit);

  const fok = await placeOrder({
    tokenId,
    side: "SELL",
    size: sizeShares,
    price: safePrice,
    orderType: "FOK"
  });

  // FOK filled — done
  if (fok.success && fok.status !== "unmatched") return fok;

  // FOK not filled — place a resting GTC sell so we still exit before resolution
  return placeOrder({
    tokenId,
    side: "SELL",
    size: sizeShares,
    price: safePrice,
    orderType: "GTC"
  });
}
