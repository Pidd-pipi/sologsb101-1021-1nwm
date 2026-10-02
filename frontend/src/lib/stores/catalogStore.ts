/**
 * 印谱 store：区段重排草稿、版本核对、落点重算、断引待修与分批写入
 * 跨页状态不留在组件内部；页面通过订阅 store 响应式更新。
 *
 * 工作流：
 * 1. 拖动条目 → moveEntry() 更新草稿（只改受影响范围，不写库）。
 * 2. 保存草稿 → saveDraft() 先核对版本号：
 *    - 版本一致：计算受影响范围并分批写入，递增版本号。
 *    - 版本不一致（别处先动过）：保留草稿，recalculateLanding() 重算落点，标记冲突。
 * 3. 写入失败：丢弃草稿，从数据库重新载入（恢复原顺序）。
 * 4. 正式编号 → assignFormalNumbers() 分批推进，断引条目先放待修区。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db } from '$lib/utils/db';
import type { Catalog, IncludedStatus } from '$lib/types/catalog';
import {
  readCatalogVersion,
  writeCatalogVersion,
  computeAffectedRange,
  computeAffectedItems,
  recalculateLanding,
  findBrokenReferences,
  batchWrite,
} from '$lib/utils/catalogOrder';

/* ------------------------------ 状态 ------------------------------ */

/** 印谱条目（数据库原始顺序） */
export const catalogRows = writable<Catalog[]>([]);
/** 是否首次载入 */
export const catalogReady = writable(false);
/** 载入错误 */
export const catalogError = writable('');
/** 排序草稿（id 列表，null 表示无草稿） */
export const draftIds = writable<string[] | null>(null);
/** 草稿对应的版本号 */
export const baseVersion = writable(0);
/** 是否检测到冲突（别处先动过） */
export const conflict = writable(false);
/** 是否正在保存 */
export const saving = writable(false);
/** 待修条目 id 集合（引用不完整） */
export const pendingFixIds = writable<Set<string>>(new Set());
/** 分批写入进度 */
export const batchProgress = writable<{ current: number; total: number } | null>(null);

/* ------------------------------ 派生 ------------------------------ */

/** 按确认顺序展开的印谱条目（有草稿时应用草稿顺序，否则按 orderNo 排序） */
export const orderedCatalog = derived(
  [catalogRows, draftIds],
  ([$rows, $draft]) => {
    if ($draft === null) {
      return [...$rows].sort((a, b) => a.orderNo - b.orderNo);
    }
    const rowMap = new Map($rows.map((row) => [row.id, row]));
    const ordered = $draft
      .map((id) => rowMap.get(id))
      .filter((row): row is Catalog => row !== undefined);
    const draftSet = new Set($draft);
    const extra = $rows
      .filter((row) => !draftSet.has(row.id))
      .sort((a, b) => a.orderNo - b.orderNo);
    return [...ordered, ...extra];
  },
);

/** 待修条目（引用不完整，不参与排序） */
export const pendingFixEntries = derived(
  [catalogRows, pendingFixIds],
  ([$rows, $fixIds]) => $rows.filter((row) => $fixIds.has(row.id)),
);

/** 是否有未保存的草稿 */
export const hasDraft = derived(draftIds, ($draft) => $draft !== null);

/** 是否有冲突 */
export const hasConflict = derived(conflict, ($conflict) => $conflict);

/* ------------------------------ 动作 ------------------------------ */

let initialized = false;

/** 初始化：载入条目与版本号，监听跨标签页变更 */
export async function initCatalogStore(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshCatalog();
  baseVersion.set(readCatalogVersion());
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorageChange);
  }
}

/** 处理 localStorage 变更事件（跨标签页同步） */
function handleStorageChange(event: StorageEvent): void {
  if (event.key !== 'gbsealcarve:catalog-version') return;
  const newVersion = readCatalogVersion();
  if (newVersion === get(baseVersion)) return;
  if (get(draftIds) !== null) {
    // 有未保存草稿：标记冲突，保留草稿
    conflict.set(true);
  } else {
    // 无草稿：直接刷新
    void refreshCatalog();
  }
}

/** 从数据库重新载入印谱条目 */
export async function refreshCatalog(): Promise<void> {
  try {
    const rows = await db.catalogs.toArray();
    catalogRows.set(rows);
    catalogError.set('');
    catalogReady.set(true);
    // 检测断引条目
    const [stones, designs] = await Promise.all([db.stones.toArray(), db.designs.toArray()]);
    const broken = findBrokenReferences(rows, stones, designs);
    pendingFixIds.set(new Set(broken.map((row) => row.id)));
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '印谱读取失败');
    catalogReady.set(true);
  }
}

/**
 * 拖动条目：更新草稿（只改受影响范围，不写库）。
 * fromId：被拖动条目 id；toId：落点条目 id。
 */
export function moveEntry(fromId: string, toId: string): void {
  const current = get(orderedCatalog);
  const orderedIds = current.map((row) => row.id);
  const result = computeAffectedRange(orderedIds, fromId, toId);
  if (!result) return;
  draftIds.set(result.newIds);
  conflict.set(false);
}

/** 保存草稿：版本核对 → 写受影响范围 → 递增版本号 */
export async function saveDraft(): Promise<void> {
  const draft = get(draftIds);
  if (!draft) return;

  saving.set(true);
  try {
    const currentVersion = readCatalogVersion();
    const base = get(baseVersion);

    if (currentVersion !== base) {
      // 冲突：保留草稿，重算落点
      const rows = await db.catalogs.toArray();
      const recalculated = recalculateLanding(rows, draft);
      draftIds.set(recalculated);
      conflict.set(true);
      baseVersion.set(currentVersion);
      saving.set(false);
      return;
    }

    // 无冲突：计算受影响范围并写入
    const currentRows = get(catalogRows);
    const currentOrdered = [...currentRows].sort((a, b) => a.orderNo - b.orderNo);
    const affectedItems = computeAffectedItems(currentOrdered, draft);

    if (affectedItems.length > 0) {
      const now = Date.now();
      const updated = affectedItems.map((item) => ({
        ...item.row,
        orderNo: item.newOrderNo,
        updatedAt: now,
      }));
      await batchWrite(
        updated,
        async (batch) => {
          await db.catalogs.bulkPut(batch);
        },
        100,
        (current, total) => {
          batchProgress.set({ current, total });
        },
      );
    }

    // 递增版本号
    const next = currentVersion + 1;
    writeCatalogVersion(next);
    baseVersion.set(next);

    // 清除草稿与冲突标记
    draftIds.set(null);
    conflict.set(false);

    await refreshCatalog();
  } catch (err) {
    // 写入失败：恢复原顺序
    draftIds.set(null);
    conflict.set(false);
    await refreshCatalog();
    catalogError.set(err instanceof Error ? err.message : '保存失败，已恢复原顺序');
  } finally {
    saving.set(false);
    batchProgress.set(null);
  }
}

/** 放弃草稿：恢复到上次确认的顺序 */
export function discardDraft(): void {
  draftIds.set(null);
  conflict.set(false);
}

/**
 * 分批正式编号：将所有引用完整的条目按当前顺序重新编号（整数连续）。
 * 引用不完整的条目先放到待修区，不参与编号。
 */
export async function assignFormalNumbers(): Promise<void> {
  saving.set(true);
  try {
    const rows = await db.catalogs.toArray();
    const [stones, designs] = await Promise.all([db.stones.toArray(), db.designs.toArray()]);
    const broken = findBrokenReferences(rows, stones, designs);
    const brokenIds = new Set(broken.map((row) => row.id));
    pendingFixIds.set(brokenIds);

    // 只对引用完整的条目编号
    const valid = rows.filter((row) => !brokenIds.has(row.id));
    const sorted = [...valid].sort((a, b) => a.orderNo - b.orderNo);
    const now = Date.now();
    const updated = sorted.map((row, index) => ({
      ...row,
      orderNo: index + 1,
      updatedAt: now,
    }));

    await batchWrite(
      updated,
      async (batch) => {
        await db.catalogs.bulkPut(batch);
      },
      100,
      (current, total) => {
        batchProgress.set({ current, total });
      },
    );

    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '编号失败');
  } finally {
    saving.set(false);
    batchProgress.set(null);
  }
}

/** 修复待修条目：重新分配印石与印稿引用 */
export async function repairEntry(id: string, stoneId: string, designId: string): Promise<void> {
  try {
    await db.catalogs.update(id, { stoneId, designId, updatedAt: Date.now() } as never);
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '修复失败');
  }
}

/** 删除条目（含待修条目），剩余条目分批重编号 */
export async function removeEntry(id: string): Promise<void> {
  try {
    await db.catalogs.delete(id);
    // 剩余条目分批重编号
    const rows = await db.catalogs.toArray();
    const sorted = [...rows].sort((a, b) => a.orderNo - b.orderNo);
    const now = Date.now();
    const updated = sorted.map((row, index) => ({
      ...row,
      orderNo: index + 1,
      updatedAt: now,
    }));
    await batchWrite(
      updated,
      async (batch) => {
        await db.catalogs.bulkPut(batch);
      },
      100,
      (current, total) => {
        batchProgress.set({ current, total });
      },
    );
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '删除失败');
  } finally {
    batchProgress.set(null);
  }
}

/** 新增印谱条目 */
export async function createEntry(stoneId: string, designId: string, note: string): Promise<void> {
  try {
    const rows = await db.catalogs.toArray();
    const maxOrderNo = rows.reduce((max, row) => Math.max(max, row.orderNo), 0);
    const now = Date.now();
    const row: Catalog = {
      id: createId('cata'),
      stoneId,
      designId,
      orderNo: maxOrderNo + 1,
      included: 'pending',
      note,
      createdAt: now,
      updatedAt: now,
    };
    await db.catalogs.put(row);
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '新增失败');
  }
}

/** 标记收录状态 */
export async function setIncluded(id: string, included: IncludedStatus): Promise<void> {
  try {
    await db.catalogs.update(id, { included, updatedAt: Date.now() } as never);
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '状态更新失败');
  }
}

/** 保存备注 */
export async function saveNote(id: string, note: string): Promise<void> {
  try {
    await db.catalogs.update(id, { note, updatedAt: Date.now() } as never);
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await refreshCatalog();
  } catch (err) {
    catalogError.set(err instanceof Error ? err.message : '备注保存失败');
  }
}
