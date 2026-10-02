/**
 * 印谱条目 store（Catalog 排序与收录的写入口）
 *
 * 排序写库统一走这里，规则：
 * 1. 保存前核对印谱版本（库内最大 updatedAt）与条目集合；
 * 2. 别处（另一标签页）先动过 → 不覆盖，保留草稿、重算落点并标记冲突；
 * 3. 正式序号只下发有变化的补丁，分批事务提交，批间让出一帧；
 * 4. 引用不全（印石或印稿缺失）的条目不占正式序号，停在待修区；
 * 5. 任一批写入失败 → 用保存前快照恢复原顺序，再向上报错。
 */
import { db } from '$lib/utils/db';
import type { Catalog, IncludedStatus } from '$lib/types/catalog';
import {
  chunkPatches,
  planFullRenumber,
  splitByReference,
  yieldToFrame,
  type OrderPatch,
  type ReferenceLookup,
} from '$lib/utils/catalogOrder';
import {
  clearCatalogDraft,
  readCatalogDraft,
  writeCatalogDraft,
  type CatalogOrderDraft,
} from '$lib/utils/catalogDraft';

/** 印谱版本：取全部条目 updatedAt 的最大值；任何一处改动都会使它前移 */
export function catalogVersion(rows: Pick<Catalog, 'updatedAt'>[]): number {
  return rows.reduce((max, row) => Math.max(max, row.updatedAt ?? 0), 0);
}

export interface BrokenCatalog extends Catalog {
  missingStone: boolean;
  missingDesign: boolean;
}

export interface CatalogBoard {
  /** 引用完整、可参与正式编号的条目（已按 orderNo 排好） */
  valid: Catalog[];
  /** 引用不全、停在待修区的条目 */
  broken: BrokenCatalog[];
  version: number;
}

/** 读取印谱当前盘面，并按引用完整性分出正式区 / 待修区 */
export async function loadCatalogBoard(): Promise<CatalogBoard> {
  return db.transaction('r', [db.catalogs, db.stones, db.designs], async () => {
    const [rows, stones, designs] = await Promise.all([
      db.catalogs.toArray(),
      db.stones.toArray(),
      db.designs.toArray(),
    ]);
    return boardFromRows(rows, new Set(stones.map((stone) => stone.id)), new Set(designs.map((design) => design.id)));
  });
}

/** 纯内存版盘面计算：liveQuery 行 + 已载入的印石/印稿 store 可直接拼出，不必反复查库 */
export function boardFromRows(rows: Catalog[], stoneIds: Set<string>, designIds: Set<string>): CatalogBoard {
  const refs: ReferenceLookup = {
    hasStone: (stoneId) => stoneIds.has(stoneId),
    hasDesign: (designId) => designIds.has(designId),
  };
  const { valid, broken } = splitByReference(rows, refs);
  return {
    valid,
    broken: broken.map((row) => ({
      ...row,
      missingStone: !stoneIds.has(row.stoneId),
      missingDesign: !designIds.has(row.designId),
    })),
    version: catalogVersion(rows),
  };
}

/**
 * 把期望的草稿顺序重算到当前盘面上：
 * 草稿里仍存在的 id 保持相对顺序（落点），别处新增的有效条目顺次补到队尾，
 * 已被别处删除的 id 丢弃。
 */
export function reconcileOrder(draftIds: readonly string[], currentValid: Catalog[]): string[] {
  const currentIds = new Set(currentValid.map((row) => row.id));
  const kept = draftIds.filter((id) => currentIds.has(id));
  const keptSet = new Set(kept);
  const appended = currentValid.map((row) => row.id).filter((id) => !keptSet.has(id));
  return [...kept, ...appended];
}

export type CommitOutcome =
  | { status: 'applied'; changed: number; chunks: number; version: number }
  | { status: 'conflict'; reason: string; savedDraft: CatalogOrderDraft }
  | { status: 'recovered'; error: string };

interface Snapshot {
  /** 保存前全部行的深拷贝，用于写入失败时恢复原顺序 */
  rows: Catalog[];
  valid: Catalog[];
  broken: Catalog[];
  version: number;
  ids: string[];
}

/** 剥掉待修区的 UI 标记字段，还原为可入库的 Catalog 行（有效行原样透传） */
function toCatalog(row: Catalog | BrokenCatalog): Catalog {
  return {
    id: row.id,
    stoneId: row.stoneId,
    designId: row.designId,
    orderNo: row.orderNo,
    included: row.included,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function readSnapshot(): Promise<Snapshot> {
  const board = await loadCatalogBoard();
  const rows = [...board.valid, ...board.broken].map((row) => ({ ...toCatalog(row) }));
  return {
    rows,
    valid: board.valid.map((row) => ({ ...row })),
    broken: board.broken.map(toCatalog),
    version: board.version,
    ids: rows.map((row) => row.id).sort(),
  };
}

/** 计算提交补丁：有效条目按期望顺序 1…n，待修条目顺延到队尾但不占正式号 */
function patchesFor(snapshot: Snapshot, validIds: string[]): OrderPatch[] {
  const byId = new Map(snapshot.valid.map((row) => [row.id, row]));
  const orderedValid = validIds
    .map((id) => byId.get(id))
    .filter((row): row is Catalog => Boolean(row));
  return planFullRenumber(orderedValid, snapshot.broken);
}

/** 按补丁组装待写行（未变化的行不下发） */
function rowsForPatches(snapshot: Snapshot, patches: OrderPatch[], now: number): Catalog[] {
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
  return patches
    .map((patch) => {
      const row = byId.get(patch.id);
      return row ? { ...row, orderNo: patch.orderNo, updatedAt: now } : null;
    })
    .filter((row): row is Catalog => Boolean(row));
}

/** 写入失败后按快照恢复原顺序（本身也分批，尽力恢复） */
async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  const chunks = chunkPatches(
    snapshot.rows.map((row) => ({ id: row.id, orderNo: row.orderNo })),
  );
  for (const chunk of chunks) {
    const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
    const restoreRows = chunk
      .map((patch) => byId.get(patch.id))
      .filter((row): row is Catalog => Boolean(row));
    // 恢复时保留原始 updatedAt，让版本号也回到保存前
    await db.transaction('rw', db.catalogs, async () => {
      await db.catalogs.bulkPut(restoreRows);
    });
  }
}

async function commitChunks(snapshot: Snapshot, patches: OrderPatch[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const now = Date.now();
  const chunks = chunkPatches(patches);
  let written = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] as OrderPatch[];
    // 每批一个独立事务：批间可让出一帧渲染进度，单批失败也能用快照整体复原
    await db.transaction('rw', db.catalogs, async () => {
      await db.catalogs.bulkPut(rowsForPatches(snapshot, chunk, now));
    });
    written += chunk.length;
    onProgress?.(written, patches.length);
    if (index < chunks.length - 1) await yieldToFrame();
  }
}

export interface CommitOptions {
  onProgress?: (done: number, total: number) => void;
}

/**
 * 带版本核对地提交排序草稿。
 * - 库内版本/集合与草稿底稿一致 → 分批写入；
 * - 不一致 → 保留草稿并重算落点，返回 conflict（不写一条正式序号）。
 */
export async function commitCatalogOrder(draft: CatalogOrderDraft, options: CommitOptions = {}): Promise<CommitOutcome> {
  const snapshot = await readSnapshot();

  if (snapshot.version !== draft.baseVersion || !sameIdSet(snapshot.ids, draft.baseIds)) {
    const reason = conflictReason(snapshot, draft);
    // 重算落点：草稿中仍然存在的条目保持其相对顺序，新插入者补到队尾
    const savedDraft: CatalogOrderDraft = {
      ...draft,
      orderedIds: reconcileOrder(draft.orderedIds, snapshot.valid),
      baseVersion: snapshot.version,
      baseIds: snapshot.ids,
      status: 'conflict',
      conflictReason: reason,
      draftedAt: Date.now(),
    };
    writeCatalogDraft(savedDraft);
    return { status: 'conflict', reason, savedDraft };
  }

  const mergedIds = reconcileOrder(draft.orderedIds, snapshot.valid);
  const patches = patchesFor(snapshot, mergedIds);
  if (patches.length === 0) {
    clearCatalogDraft();
    return { status: 'applied', changed: 0, chunks: 0, version: snapshot.version };
  }

  try {
    await commitChunks(snapshot, patches, options.onProgress);
  } catch (error) {
    await restoreSnapshot(snapshot).catch(() => {
      /* 恢复失败也不再覆盖，保留现场交由用户刷新/备份 */
    });
    return { status: 'recovered', error: error instanceof Error ? error.message : '写入失败' };
  }

  clearCatalogDraft();
  return { status: 'applied', changed: patches.length, chunks: chunkPatches(patches).length, version: Date.now() };
}

/** 跳过版本核对的全量重排（本页新增/删除条目后使用），同样分批 + 失败恢复 */
export async function forceCatalogOrder(validIds: string[], options: CommitOptions = {}): Promise<CommitOutcome> {
  const snapshot = await readSnapshot();
  const mergedIds = reconcileOrder(validIds, snapshot.valid);
  const patches = patchesFor(snapshot, mergedIds);
  if (patches.length === 0) return { status: 'applied', changed: 0, chunks: 0, version: snapshot.version };
  try {
    await commitChunks(snapshot, patches, options.onProgress);
  } catch (error) {
    await restoreSnapshot(snapshot).catch(() => {});
    return { status: 'recovered', error: error instanceof Error ? error.message : '写入失败' };
  }
  return { status: 'applied', changed: patches.length, chunks: chunkPatches(patches).length, version: Date.now() };
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}

function conflictReason(snapshot: Snapshot, draft: CatalogOrderDraft): string {
  const current = new Set(snapshot.ids);
  const base = new Set(draft.baseIds);
  const added = snapshot.ids.filter((id) => !base.has(id));
  const removed = draft.baseIds.filter((id) => !current.has(id));
  const parts: string[] = [];
  if (snapshot.version !== draft.baseVersion) parts.push('收录或顺序已被别处更新');
  if (added.length > 0) parts.push(`新增 ${added.length} 条`);
  if (removed.length > 0) parts.push(`移除 ${removed.length} 条`);
  return parts.length > 0 ? parts.join('，') : '印谱版本不一致';
}

/** 本页快速改动（收录状态/备注）后，把未保存草稿的底稿版本前移到最新，避免自己顶掉自己 */
export async function rebaseDraft(): Promise<CatalogOrderDraft | null> {
  const draft = readCatalogDraft();
  if (!draft) return null;
  const board = await loadCatalogBoard();
  const next: CatalogOrderDraft = {
    ...draft,
    orderedIds: reconcileOrder(draft.orderedIds, board.valid),
    baseVersion: board.version,
    baseIds: [...board.valid, ...board.broken].map((row) => row.id).sort(),
    draftedAt: Date.now(),
  };
  writeCatalogDraft(next);
  return next;
}

/** 追加一条印谱条目到正式区末尾（正式区序号连续时无需整表重编号） */
export async function appendCatalogEntry(
  payload: Omit<Catalog, 'id' | 'createdAt' | 'updatedAt' | 'orderNo'>,
): Promise<Catalog> {
  const maxOrder = (await db.catalogs.toArray()).reduce((max, row) => Math.max(max, row.orderNo), 0);
  const now = Date.now();
  const row: Catalog = {
    ...payload,
    orderNo: maxOrder + 1,
    id: `cata_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
  };
  await db.catalogs.put(row);
  return row;
}

/** 删除条目（正式区或待修区）；无未保存草稿时其余条目分批重编号 */
export async function removeCatalogEntry(id: string, draftActive = false): Promise<void> {
  await db.catalogs.delete(id);
  if (!draftActive) {
    const board = await loadCatalogBoard();
    await forceCatalogOrder(board.valid.map((item) => item.id));
  }
}

/** 切换收录状态 / 改备注等单行快改 */
export async function patchCatalogEntry(id: string, patch: { included?: IncludedStatus; note?: string }): Promise<void> {
  await db.catalogs.update(id, { ...patch, updatedAt: Date.now() });
}

export { readCatalogDraft, writeCatalogDraft, clearCatalogDraft };
export type { CatalogOrderDraft } from '$lib/utils/catalogDraft';
