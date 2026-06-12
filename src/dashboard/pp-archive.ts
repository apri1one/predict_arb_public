/**
 * Auto PP-Farmer 排除清单（Archive）
 *
 * 用户在 All 面板把不想自动挂单的市场加进归档；pp-farmer 在选候选时跳过这些 marketId。
 * 持久化到 ${DATA_DIR}/pp-archive.json。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export interface ArchiveEntry {
    marketId: number;
    title: string;
    archivedAt: number;
    reason?: string;
}

let archive = new Map<number, ArchiveEntry>();
let filePath: string | null = null;
let initialized = false;

function persist(): void {
    if (!filePath) return;
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        const arr = Array.from(archive.values()).sort((a, b) => b.archivedAt - a.archivedAt);
        writeFileSync(filePath, JSON.stringify(arr, null, 2));
    } catch (err: any) {
        console.warn('[PP-Archive] save failed:', err?.message || err);
    }
}

export function initPpArchive(path: string): void {
    filePath = path;
    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, 'utf-8');
            const arr: ArchiveEntry[] = JSON.parse(raw);
            archive = new Map(arr.map((e) => [Number(e.marketId), e]));
        } catch (err: any) {
            console.warn('[PP-Archive] load failed, starting empty:', err?.message || err);
            archive = new Map();
        }
    }
    initialized = true;
    console.log(`[PP-Archive] initialized: ${archive.size} markets archived`);
}

export function isArchived(marketId: number): boolean {
    return initialized && archive.has(Number(marketId));
}

export function getArchivedMarketIds(): Set<number> {
    return new Set(archive.keys());
}

export function getArchive(): ArchiveEntry[] {
    return Array.from(archive.values()).sort((a, b) => b.archivedAt - a.archivedAt);
}

export function addToArchive(marketId: number, title: string, reason?: string): ArchiveEntry {
    const id = Number(marketId);
    if (!Number.isFinite(id)) throw new Error('marketId must be a finite number');
    const entry: ArchiveEntry = {
        marketId: id,
        title: title || `market ${id}`,
        archivedAt: Date.now(),
        ...(reason ? { reason } : {}),
    };
    archive.set(id, entry);
    persist();
    return entry;
}

export function removeFromArchive(marketId: number): boolean {
    const id = Number(marketId);
    if (!archive.has(id)) return false;
    archive.delete(id);
    persist();
    return true;
}
