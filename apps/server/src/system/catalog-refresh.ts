import type { Store } from '../db.js';
import { ApiFailure } from '../util.js';
export function catalogRefreshSettings(db: Store): { intervalMinutes: number } {
  const value = Number(db.get("SELECT value FROM admin_settings WHERE key='catalogRefreshMinutes'")?.value ?? 60);
  return { intervalMinutes: Number.isInteger(value) && value >= 1 && value <= 10080 ? value : 60 };
}
export const catalogRefreshMs = (db: Store) => catalogRefreshSettings(db).intervalMinutes * 60_000;
export function setCatalogRefreshSettings(db: Store, intervalMinutes: number) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) throw new ApiFailure(400, 'invalid-request');
  db.run("INSERT OR REPLACE INTO admin_settings VALUES('catalogRefreshMinutes',?)", String(intervalMinutes));
  return catalogRefreshSettings(db);
}

/** The administrator scales the existing per-kind cadence around the default 60-minute frequency. */
export const catalogFreshMs = (db: Store, baselineMs: number) => baselineMs * catalogRefreshSettings(db).intervalMinutes / 60;
