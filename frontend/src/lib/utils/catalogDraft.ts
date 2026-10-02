/**
 * 印谱排序草稿暂存（localStorage）
 *
 * 作者在清单上连续拖动几十条时，落点先存在本地草稿里，不逐条写 IndexedDB；
 * 点「保存排序」时再带版本核对提交。若另一标签页已先改过收录/顺序，
 * 草稿不会被丢弃——保留在本地并标记为 conflict，等待重算落点后再确认。
 */

/** 草稿状态：编辑中 / 与库内新版本冲突（待重算落点） */
export type CatalogDraftStatus = 'editing' | 'conflict';

export interface CatalogOrderDraft {
  /** 草稿展开后的条目 id 顺序（仅有效条目；待修条目不参与排序） */
  orderedIds: string[];
  /** 起草时所依据的印谱版本（库内最大 updatedAt） */
  baseVersion: number;
  /** 起草时的条目快照 id 列表，用于识别别处是否新增/删除了条目 */
  baseIds: string[];
  status: CatalogDraftStatus;
  /** 冲突时记录原因，供页面提示 */
  conflictReason: string;
  /** 最近一次本地编辑时间 */
  draftedAt: number;
}

const STORAGE_KEY = 'gbsealcarve:catalog-order-draft';

export function readCatalogDraft(): CatalogOrderDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogOrderDraft>;
    if (!Array.isArray(parsed.orderedIds) || typeof parsed.baseVersion !== 'number') return null;
    return {
      orderedIds: parsed.orderedIds.filter((id): id is string => typeof id === 'string'),
      baseVersion: parsed.baseVersion,
      baseIds: Array.isArray(parsed.baseIds) ? parsed.baseIds.filter((id): id is string => typeof id === 'string') : [],
      status: parsed.status === 'conflict' ? 'conflict' : 'editing',
      conflictReason: typeof parsed.conflictReason === 'string' ? parsed.conflictReason : '',
      draftedAt: typeof parsed.draftedAt === 'number' ? parsed.draftedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeCatalogDraft(draft: CatalogOrderDraft): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* 隐私模式或配额受限时忽略：页面仍可当场保存，只是无法跨刷新留草稿 */
  }
}

export function clearCatalogDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
