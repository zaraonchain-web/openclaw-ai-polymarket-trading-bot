import fs from "node:fs";
import path from "node:path";
import type { LivePosition } from "../types/index.js";

const defaultPath = path.join(process.cwd(), "open-positions.json");

function loadPositions(filePath = defaultPath): LivePosition[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function savePositions(positions: LivePosition[], filePath = defaultPath): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(positions, null, 2), "utf-8");
}

export function getOpenPositions(filePath = defaultPath): LivePosition[] {
  return loadPositions(filePath);
}

export function hasOpenPosition(marketId: string, filePath = defaultPath): boolean {
  return loadPositions(filePath).some((p) => p.marketId === marketId);
}

export function addPosition(position: LivePosition, filePath = defaultPath): void {
  const positions = loadPositions(filePath);
  if (positions.some((p) => p.marketId === position.marketId)) return;
  positions.push(position);
  savePositions(positions, filePath);
}

export function removePosition(marketId: string, filePath = defaultPath): void {
  const positions = loadPositions(filePath).filter((p) => p.marketId !== marketId);
  savePositions(positions, filePath);
}

export function getPositionsDueToClose(
  closeAfterSeconds: number,
  filePath = defaultPath
): LivePosition[] {
  if (closeAfterSeconds <= 0) return [];
  const now = Date.now();
  const threshold = closeAfterSeconds * 1000;
  return loadPositions(filePath).filter((p) => now - p.openedAt >= threshold);
}
