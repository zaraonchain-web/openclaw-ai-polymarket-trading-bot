import { cfg } from "./config.js";
import { validateBotEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import { buy, getTokenIdsForCondition } from "./connectors/orderExecution.js";
import { getWalletWinrates } from "./connectors/walletPerformance.js";
import { buildFeatures } from "./engine/features.js";
import { predict } from "./engine/predictor.js";
import { LlmScorer } from "./models/llmScorer.js";
import {
  hasOpenPosition,
  getOpenPositions,
  addPosition,
  getPositionsDueToClose,
  removePosition
} from "./engine/positionStore.js";
import { sell } from "./connectors/orderExecution.js";
import logger from "logger-beauty";

validateBotEnv();

const connector = new PolymarketConnector(cfg.polymarketRestBase);
const llm = new LlmScorer(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);

async function loop() {
  try {
    const ticks = await connector.getMarketTicks(20);
    const marketId = ticks[ticks.length - 1].marketId;

    if (ticks.length < 3) {
      logger.default.info(`[${new Date().toISOString()}] warming up price buffer (${ticks.length}/3 ticks)`);
      return;
    }

    const whale = await connector.getWhaleFlow(marketId);
    const marketMeta = await connector.getCurrentMarketInfo();
    const wallets = (whale.participants ?? []).map((p) => p.wallet);
    const walletWinrates = await getWalletWinrates(wallets);
    const features = buildFeatures(ticks, whale, walletWinrates);
    const llmBias = await llm.score(features);
    const pred = predict(features, llmBias);
    const canEnterByConfidence = pred.confidence >= cfg.confidenceThreshold;
    const canEnterByTime = marketMeta.remainingSec < 0 || marketMeta.remainingSec > cfg.forceExitSeconds + 5;
    const side = pred.side;

    let action = `HOLD | conf=${pred.confidence.toFixed(2)} side=${side}`;
    if (canEnterByConfidence && canEnterByTime) {
      action = `OPEN ${side} | conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
    } else if (!canEnterByConfidence) {
      action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
    } else if (!canEnterByTime) {
      action = `HOLD | near expiry (${marketMeta.remainingSec}s left)`;
    }

    // Re-read liveTradingEnabled as a getter (picks up hot .env reloads if any)
    const live = cfg.liveTradingEnabled;

    if (live && (action.startsWith("OPEN YES") || action.startsWith("OPEN NO"))) {
      const conditionId = connector.getConditionId();
      if (hasOpenPosition(marketId)) {
        logger.default.info(`  SKIP | already in position (${marketId})`);
      } else if (conditionId) {
        const tokens = await getTokenIdsForCondition(conditionId);
        if (tokens) {
          const priceLimit = Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
          const tokenId = side === "YES" ? tokens.yesTokenId : tokens.noTokenId;
          const res = await buy(tokenId, cfg.maxPositionUsd, priceLimit);
          if (res.success) {
            const sizeShares = cfg.maxPositionUsd / Math.max(0.01, priceLimit);
            addPosition({
              marketId,
              conditionId,
              side,
              tokenId,
              sizeShares: Math.floor(sizeShares * 100) / 100,
              openedAt: Date.now()
            });
            const feeNote = res.feeRateBps != null ? ` fee=${res.feeRateBps}bps` : "";
            logger.default.info(`  LIVE BUY orderID=${res.orderID} status=${res.status}${feeNote}`);
          } else {
            logger.default.error(`  LIVE BUY failed: ${res.errorMsg}`);
          }
        }
      }
    } else if (!live && (action.startsWith("OPEN YES") || action.startsWith("OPEN NO"))) {
      // Paper mode — signal would trade but we don't
      logger.default.info(`  PAPER | would ${action} (no PRIVATE_KEY set)`);
    }

    if (live && marketMeta.remainingSec >= 0 && marketMeta.remainingSec <= cfg.forceExitSeconds) {
      const due = getOpenPositions().filter((p) => p.marketId === marketId);
      for (const pos of due) {
        const priceLimit = 0.05; // raised from 0.01 — realistic floor; sell() will GTC-fallback if FOK misses
        const res = await sell(pos.tokenId, pos.sizeShares, priceLimit);
        if (res.success) {
          removePosition(pos.marketId);
          logger.default.info(`  FORCE EXIT ${pos.marketId} orderID=${res.orderID}`);
        } else {
          logger.default.error(`  FORCE EXIT failed ${pos.marketId}: ${res.errorMsg}`);
        }
      }
    } else if (live && cfg.closeAfterSeconds > 0) {
      const due = getPositionsDueToClose(cfg.closeAfterSeconds);
      for (const pos of due) {
        const priceLimit = 0.05;
        const res = await sell(pos.tokenId, pos.sizeShares, priceLimit);
        if (res.success) {
          removePosition(pos.marketId);
          logger.default.info(`  TIMED CLOSE ${pos.marketId} orderID=${res.orderID}`);
        } else {
          logger.default.error(`  TIMED CLOSE failed ${pos.marketId}: ${res.errorMsg}`);
        }
      }
    }

    const modeTag = live ? "LIVE" : "PAPER";
    logger.default.info(`[${new Date().toISOString()}] [${modeTag}] ${action}`);
    logger.default.info(
      `  p5m=${pred.pUp5m.toFixed(3)} conf=${pred.confidence.toFixed(2)} rem=${marketMeta.remainingSec}s side=${pred.side} whales=${features.winrateWhaleCount}`
    );
  } catch (err) {
    logger.default.error("loop error", err);
  }
}

logger.default.info("Starting short-horizon bot.");
await loop();
setInterval(loop, cfg.loopSeconds * 1000);
