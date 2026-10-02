/**
 * 印谱排序纯函数：按区段排定拖动落点、找出受影响范围、分批重编号。
 *
 * 设计要点（对应千方以上大表）：
 * - 拖动一条只改变 [min(旧位,新位), max(旧位,新位)] 这一区段的序号，区段外不写；
 * - 序号分批推进，避免一次性 put 上千行造成页面卡顿；
 * - 引用不全（印石或印稿已删除）的条目不占正式序号，先抽到待修区；
 * - 本文件不含 IndexedDB 读写，便于单测与在事务中复用。
 */

/** 排序所需的最小条目结构 */
export interface OrderItem {
  id: string;
  orderNo: number;
}

/** 引用完整性：印石与印稿必须同时存在 */
export interface ReferenceLookup {
  hasStone: (stoneId: string) => boolean;
  hasDesign: (designId: string) => boolean;
}

/** 每批写入的条目数：既不触发长任务卡顿，也不产生过多事务轮次 */
export const ORDER_BATCH_SIZE = 80;

/**
 * 稳定排序：按 orderNo 升序；同号（历史脏数据/待修项）按 id 兜底，
 * 保证两个标签页对同一份数据算出的落点一致。
 */
export function sortByOrder<T extends OrderItem>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.orderNo === b.orderNo ? a.id.localeCompare(b.id) : a.orderNo - b.orderNo));
}

/** 把列表拆成「可正式编号的有效条目」与「引用不全的待修条目」 */
export function splitByReference<T extends OrderItem & { stoneId: string; designId: string }>(
  items: T[],
  refs: ReferenceLookup,
): { valid: T[]; broken: T[] } {
  const valid: T[] = [];
  const broken: T[] = [];
  for (const item of sortByOrder(items)) {
    if (refs.hasStone(item.stoneId) && refs.hasDesign(item.designId)) valid.push(item);
    else broken.push(item);
  }
  return { valid, broken };
}

/**
 * 区段移动：把 id 为 movedId 的条目从当前位置移动到目标位置，
 * 只返回移动后的 id 顺序，不触碰区段以外的数据。
 * 目标位置以移动前列表下标计：拖动到第 targetIndex 位（0 起）。
 */
export function moveWithinSegment(orderedIds: string[], movedId: string, targetIndex: number): string[] {
  const from = orderedIds.indexOf(movedId);
  if (from < 0) return [...orderedIds];
  const to = Math.max(0, Math.min(targetIndex, orderedIds.length - 1));
  if (from === to) return [...orderedIds];
  const next = [...orderedIds];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as string);
  return next;
}

/**
 * 根据移动前后的 id 顺序，求受影响区段 [lo, hi]（0 起，闭区间）。
 * 区段外序号不变，区段内才需要写库；位置未变返回 null。
 */
export function affectedRange(
  beforeIds: readonly string[],
  afterIds: readonly string[],
): { lo: number; hi: number } | null {
  if (beforeIds.length !== afterIds.length) return { lo: 0, hi: afterIds.length - 1 };
  let lo = 0;
  while (lo < afterIds.length && beforeIds[lo] === afterIds[lo]) lo += 1;
  if (lo === afterIds.length) return null;
  let hi = afterIds.length - 1;
  while (hi >= 0 && beforeIds[hi] === afterIds[hi]) hi -= 1;
  return { lo, hi: Math.max(lo, hi) };
}

/** 待写入的单条序号变更 */
export interface OrderPatch {
  id: string;
  orderNo: number;
}

/**
 * 只对受影响区段编号：区段内从 lo+1 起连续编号，区段外保持原 orderNo。
 * 返回真正需要写入的条目（序号发生变化者），未变化的不下发写操作。
 */
export function planSegmentRenumber<T extends OrderItem>(
  before: T[],
  afterIds: readonly string[],
  range: { lo: number; hi: number },
): OrderPatch[] {
  const current = new Map(before.map((item) => [item.id, item]));
  const patches: OrderPatch[] = [];
  for (let index = range.lo; index <= range.hi; index += 1) {
    const id = afterIds[index];
    if (!id) continue;
    const orderNo = index + 1;
    if (current.get(id)?.orderNo !== orderNo) patches.push({ id, orderNo });
  }
  return patches;
}

/**
 * 全量连续性重编号（删除/新增/版本冲突重算落点后使用）：
 * 有效条目 1…n 连续编号；待修条目统一压到正式区之后（n+1、n+2…），且总是下发，
 * 避免其保留的旧序号与正式区撞号、按 orderNo 排序时插回正式区。
 */
export function planFullRenumber<T extends OrderItem>(validInOrder: T[], brokenInOrder: T[] = []): OrderPatch[] {
  const patches: OrderPatch[] = [];
  validInOrder.forEach((item, index) => {
    const orderNo = index + 1;
    if (item.orderNo !== orderNo) patches.push({ id: item.id, orderNo });
  });
  brokenInOrder.forEach((item, index) => {
    // 不做“未变化则跳过”：必须确保待修条目一律落在正式区尾号之后
    patches.push({ id: item.id, orderNo: validInOrder.length + index + 1 });
  });
  return patches;
}

/** 把补丁数组按固定批次大小切分，供调用方分批提交、分批让出主线程 */
export function chunkPatches(patches: OrderPatch[], batchSize: number = ORDER_BATCH_SIZE): OrderPatch[][] {
  if (batchSize <= 0) throw new Error('batchSize 必须为正整数');
  const chunks: OrderPatch[][] = [];
  for (let start = 0; start < patches.length; start += batchSize) {
    chunks.push(patches.slice(start, start + batchSize));
  }
  return chunks;
}

/** 让出一帧，避免大批量编号时长时间阻塞页面 */
export function yieldToFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
