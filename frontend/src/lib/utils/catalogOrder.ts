/**
 * 印谱排序工具：区段重排、版本核对、落点重算、断引检测与分批写入
 * 纯函数 + 少量 localStorage 元数据，不依赖后端。
 *
 * 设计要点：
 * - 拖动只改受影响范围（from 与 to 之间的条目），范围外保持原序号，避免整表重编号卡住页面。
 * - 保存前核对印谱版本号（localStorage 元数据，跨标签页共享），别处先动过则留草稿并重算落点。
 * - 正式序号分批推进（每批 BATCH_SIZE 条，批间让出事件循环），大批量也不卡页面。
 * - 引用不完整的条目先放待修区，不参与排序与编号。
 * - 写入失败恢复原顺序（草稿丢弃，从数据库重新载入）。
 */
import type { Catalog } from '$lib/types/catalog';
import type { Stone } from '$lib/types/stone';
import type { Design } from '$lib/types/design';

/** localStorage 印谱版本键（跨标签页共享，storage 事件可通知变更） */
export const CATALOG_VERSION_KEY = 'gbsealcarve:catalog-version';

/** 批次大小：每批写入的条目数，避免大批量操作卡住页面 */
export const BATCH_SIZE = 100;

/* ------------------------------ 版本管理 ------------------------------ */

/** 读取印谱版本号（localStorage 元数据，跨标签页共享） */
export function readCatalogVersion(): number {
  try {
    const raw = localStorage.getItem(CATALOG_VERSION_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { version?: number };
    return typeof parsed.version === 'number' ? parsed.version : 0;
  } catch {
    return 0;
  }
}

/** 写入印谱版本号 */
export function writeCatalogVersion(version: number): void {
  try {
    localStorage.setItem(CATALOG_VERSION_KEY, JSON.stringify({ version, updatedAt: Date.now() }));
  } catch {
    /* 隐私模式下忽略 */
  }
}

/* ------------------------------ 区段重排 ------------------------------ */

export interface AffectedRange {
  /** 新的完整顺序（id 列表） */
  newIds: string[];
  /** 受影响范围的条目 id */
  affectedIds: string[];
  /** 受影响范围起始索引 */
  minIndex: number;
  /** 受影响范围结束索引 */
  maxIndex: number;
}

/**
 * 计算拖动的受影响范围与新顺序。
 * 只更新 from 与 to 之间（含端点）的条目，范围外的条目保持原序号。
 */
export function computeAffectedRange(orderedIds: string[], fromId: string, toId: string): AffectedRange | null {
  const fromIndex = orderedIds.indexOf(fromId);
  const toIndex = orderedIds.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

  const newIds = [...orderedIds];
  const [moved] = newIds.splice(fromIndex, 1);
  newIds.splice(toIndex, 0, moved as string);

  const minIndex = Math.min(fromIndex, toIndex);
  const maxIndex = Math.max(fromIndex, toIndex);

  return {
    newIds,
    affectedIds: newIds.slice(minIndex, maxIndex + 1),
    minIndex,
    maxIndex,
  };
}

export interface AffectedItem {
  row: Catalog;
  newOrderNo: number;
}

/**
 * 计算当前顺序与目标顺序之间发生位置变化的条目（即受影响范围）。
 * 仅这些条目需要回写 orderNo，范围外的条目保持原序号不变。
 */
export function computeAffectedItems(currentOrdered: Catalog[], draftIds: string[]): AffectedItem[] {
  const currentIds = currentOrdered.map((row) => row.id);
  const rowMap = new Map(currentOrdered.map((row) => [row.id, row]));
  const affected: AffectedItem[] = [];

  for (let newIndex = 0; newIndex < draftIds.length; newIndex += 1) {
    const id = draftIds[newIndex] as string;
    const row = rowMap.get(id);
    if (!row) continue;
    const oldIndex = currentIds.indexOf(id);
    if (oldIndex !== newIndex) {
      affected.push({ row, newOrderNo: newIndex + 1 });
    }
  }

  return affected;
}

/* ------------------------------ 落点重算 ------------------------------ */

/**
 * 别处先动过后，根据当前数据库状态重算落点。
 * 保留草稿中仍存在的条目的相对顺序，新增条目追加到末尾。
 */
export function recalculateLanding(currentRows: Catalog[], draftIds: string[]): string[] {
  const currentIds = currentRows.map((row) => row.id);
  const draftSet = new Set(draftIds);
  const keptDraft = draftIds.filter((id) => currentIds.includes(id));
  const newItems = currentIds.filter((id) => !draftSet.has(id));
  return [...keptDraft, ...newItems];
}

/* ------------------------------ 断引检测 ------------------------------ */

/** 引用不完整的条目（stoneId 或 designId 在对应表中不存在） */
export function findBrokenReferences(catalogs: Catalog[], stones: Stone[], designs: Design[]): Catalog[] {
  const stoneIds = new Set(stones.map((stone) => stone.id));
  const designIds = new Set(designs.map((design) => design.id));
  return catalogs.filter((catalog) => !stoneIds.has(catalog.stoneId) || !designIds.has(catalog.designId));
}

/* ------------------------------ 分批写入 ------------------------------ */

/** 让出事件循环，保持页面响应 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 分批写入条目，每批 batchSize 条，批间让出事件循环。
 * onProgress 回调报告进度，避免大批量操作卡住页面。
 */
export async function batchWrite<T>(
  items: T[],
  writeBatch: (batch: T[]) => Promise<void>,
  batchSize: number = BATCH_SIZE,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const total = items.length;
  for (let i = 0; i < total; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await writeBatch(batch);
    onProgress?.(Math.min(i + batchSize, total), total);
    await yieldToMain();
  }
}
