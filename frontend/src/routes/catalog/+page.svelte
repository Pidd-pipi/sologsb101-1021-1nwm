<script lang="ts">
  /**
   * /catalog 印谱汇总与排序
   * 按区段排定顺序：拖动只改受影响范围，落点先存本地草稿；保存前核对印谱版本，
   * 别处先动过则保留草稿并重算落点；正式序号分批提交，写入失败恢复原顺序。
   * 引用不全（印石或印稿缺失）的条目停在待修区，不占正式序号、不进印谱清单。
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import GradeTag from '$lib/components/common/GradeTag.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { designs, loadDesigns } from '$lib/stores/designStore';
  import { carves, loadCarves } from '$lib/stores/carveStore';
  import { impressions, loadImpressions, bestImpressionOf } from '$lib/stores/impressionStore';
  import { loadStones, stones } from '$lib/stores/stoneStore';
  import {
    appendCatalogEntry,
    boardFromRows,
    clearCatalogDraft,
    commitCatalogOrder,
    patchCatalogEntry,
    rebaseDraft,
    readCatalogDraft,
    removeCatalogEntry,
    writeCatalogDraft,
    type CatalogOrderDraft,
  } from '$lib/stores/catalogStore';
  import {
    INCLUDED_COLOR,
    INCLUDED_OPTIONS,
    type Catalog,
    type IncludedStatus,
  } from '$lib/types/catalog';
  import { moveWithinSegment } from '$lib/utils/catalogOrder';
  import {
    DB_NAME,
    DB_VERSION,
    exportSnapshot,
    importSnapshot,
    readLastBackupAt,
    resetDatabase,
    writeLastBackupAt,
  } from '$lib/utils/db';
  import {
    buildCatalogText,
    copyText,
    exportCatalogText,
    exportImpressionCsv,
    exportSnapshotJson,
    validateSnapshot,
  } from '$lib/utils/export';
  import type { SealCarveSnapshot } from '$lib/utils/db';

  // 印谱条目没有独立 store：本页通过 useIdbTable 的 liveQuery 订阅，排序写库统一走 catalogStore
  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let fileInput = $state<HTMLInputElement | null>(null);
  let lastBackupAt = $state<string | null>(readLastBackupAt());
  let toast = $state<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  let pendingDelete = $state<Catalog | null>(null);
  let dialogOpen = $state(false);
  let newStoneId = $state('');
  let newDesignId = $state('');
  let newNote = $state('');

  // 排序草稿（未确认不落正式序号）、拖拽态、分批保存进度
  let draft = $state<CatalogOrderDraft | null>(readCatalogDraft());
  let dragId = $state('');
  let saving = $state(false);
  let saveProgress = $state<{ done: number; total: number } | null>(null);

  const stoneIds = $derived(new Set($stones.map((stone) => stone.id)));
  const designIds = $derived(new Set($designs.map((design) => design.id)));
  const board = $derived(boardFromRows($catalogRows, stoneIds, designIds));

  // 清单按「确认后的顺序」展开：未保存草稿只影响页面上的拖动预览，不进清单
  const confirmed = $derived(board.valid);

  const context = $derived({
    stones: $stones,
    designs: $designs,
    carves: $carves,
    impressions: $impressions,
    catalogs: confirmed,
  });

  const catalogText = $derived(buildCatalogText(context));

  // 拖动预览顺序：有草稿按草稿（仍过滤已不存在的条目），否则按正式顺序
  const displayed = $derived(
    draft
      ? draft.orderedIds
          .map((id) => board.valid.find((item) => item.id === id))
          .filter((item): item is Catalog => Boolean(item))
      : board.valid,
  );

  const stat = $derived({
    total: board.valid.length,
    included: board.valid.filter((item) => item.included === 'included').length,
    pending: board.valid.filter((item) => item.included === 'pending').length,
    excluded: board.valid.filter((item) => item.included === 'excluded').length,
    broken: board.broken.length,
  });

  const unlistedDesigns = $derived(
    $designs.filter((design) => !$catalogRows.some((item) => item.designId === design.id)),
  );
  const designsOfNewStone = $derived(unlistedDesigns.filter((design) => design.stoneId === newStoneId));

  $effect(() => {
    if (newStoneId.length === 0 && $stones.length > 0) newStoneId = $stones[0]?.id ?? '';
  });

  $effect(() => {
    const first = designsOfNewStone[0];
    if (first && !designsOfNewStone.some((design) => design.id === newDesignId)) newDesignId = first.id;
  });

  function designText(designId: string): string {
    const design = $designs.find((item) => item.id === designId);
    return design ? `${design.sealText}（${design.annotation || '无释文'}）` : '（印稿已删除）';
  }

  function stoneText(stoneId: string): string {
    return $stones.find((stone) => stone.id === stoneId)?.name ?? '（印石已删除）';
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): void {
    toast = { text, tone };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 3200);
  }

  /** 以当前盘面起草排序草稿（拖动的落点暂存，不写正式序号） */
  function ensureDraft(): CatalogOrderDraft | null {
    if (draft) return draft;
    if (board.valid.length === 0) return null;
    draft = {
      orderedIds: board.valid.map((item) => item.id),
      baseVersion: board.version,
      baseIds: [...board.valid, ...board.broken].map((item) => item.id).sort(),
      status: 'editing',
      conflictReason: '',
      draftedAt: Date.now(),
    };
    writeCatalogDraft(draft);
    return draft;
  }

  /** 区段移动：只重排受影响范围，草稿外的正式序号不动 */
  function reorderTo(movedId: string, targetIndex: number): void {
    const current = draft ? draft.orderedIds : board.valid.map((item) => item.id);
    const from = current.indexOf(movedId);
    if (from < 0) return;
    const orderedIds = moveWithinSegment(current, movedId, targetIndex);
    if (orderedIds.every((id, index) => id === current[index])) return;
    const base = ensureDraft();
    if (!base) return;
    draft = { ...base, orderedIds, status: 'editing', conflictReason: '', draftedAt: Date.now() };
    writeCatalogDraft(draft);
  }

  async function move(entry: Catalog, delta: number): Promise<void> {
    if (saving) return;
    const list = displayed.map((item) => item.id);
    const index = list.indexOf(entry.id);
    if (index < 0) return;
    reorderTo(entry.id, index + delta);
  }

  async function handleDrop(targetId: string): Promise<void> {
    const movedId = dragId;
    dragId = '';
    if (!movedId || movedId === targetId || saving) return;
    const index = displayed.findIndex((item) => item.id === targetId);
    if (index >= 0) reorderTo(movedId, index);
  }

  async function setIncluded(entry: Catalog, included: IncludedStatus): Promise<void> {
    await patchCatalogEntry(entry.id, { included });
    // 自己刚改过收录状态：把未保存草稿的底稿版本前移，避免保存时误判为冲突
    if (draft) draft = await rebaseDraft();
  }

  async function saveNote(entry: Catalog, note: string): Promise<void> {
    await patchCatalogEntry(entry.id, { note });
    if (draft) draft = await rebaseDraft();
  }

  async function saveOrder(): Promise<void> {
    if (!draft || saving) return;
    saving = true;
    saveProgress = { done: 0, total: draft.orderedIds.length };
    try {
      const outcome = await commitCatalogOrder(draft, {
        onProgress: (done, total) => {
          saveProgress = { done, total };
        },
      });
      if (outcome.status === 'applied') {
        draft = null;
        showToast(outcome.changed === 0 ? '顺序无变化，未写入' : `已按区段写入 ${outcome.changed} 条（${outcome.chunks} 批）`);
      } else if (outcome.status === 'conflict') {
        draft = outcome.savedDraft;
        showToast(`别处已先改动：${outcome.reason}。草稿已保留，落点已重算，请核对后再保存`, 'warn');
      } else {
        showToast(`写入失败，已恢复原顺序：${outcome.error}`, 'err');
      }
    } finally {
      saving = false;
      saveProgress = null;
    }
  }

  function discardDraft(): void {
    clearCatalogDraft();
    draft = null;
    showToast('已放弃未保存的排序调整');
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    pendingDelete = null;
    await removeCatalogEntry(id, Boolean(draft));
    if (draft) draft = await rebaseDraft();
    showToast('已移出印谱，其余条目序号保持区段不变');
  }

  function openCreate(): void {
    if (unlistedDesigns.length === 0) {
      showToast('所有印稿都已进入印谱', 'warn');
      return;
    }
    newStoneId = unlistedDesigns[0]?.stoneId ?? $stones[0]?.id ?? '';
    newDesignId = unlistedDesigns[0]?.id ?? '';
    newNote = '';
    dialogOpen = true;
  }

  async function submitNew(): Promise<void> {
    const design = $designs.find((item) => item.id === newDesignId);
    if (!design) return;
    await appendCatalogEntry({
      stoneId: design.stoneId,
      designId: design.id,
      included: 'pending',
      note: newNote,
    });
    if (draft) draft = await rebaseDraft();
    dialogOpen = false;
    showToast(`已加入印谱：${design.sealText}`);
  }

  async function handleExport(): Promise<void> {
    const snapshot = await exportSnapshot();
    const filename = exportSnapshotJson(snapshot);
    const stamp = new Date().toISOString();
    writeLastBackupAt(stamp);
    lastBackupAt = stamp;
    showToast(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`);
  }

  async function handleImport(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast('JSON 解析失败，请确认文件格式', 'err');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      showToast(invalid, 'err');
      return;
    }
    if (!window.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，操作不可撤销。是否继续？')) return;
    await importSnapshot(parsed as SealCarveSnapshot);
    clearCatalogDraft();
    draft = null;
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    showToast('导入完成，数据已覆盖');
  }

  async function handleReset(): Promise<void> {
    if (!window.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。是否继续？')) return;
    await resetDatabase();
    clearCatalogDraft();
    draft = null;
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
    showToast('已清空并重新载入演示数据');
  }

  const toastClass = $derived(
    toast?.tone === 'err'
      ? 'border-seal/40 bg-seal/10 text-seal'
      : toast?.tone === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
        : 'border-jade/40 bg-jade/10 text-jade',
  );
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">印谱汇总与数据导出</h2>
      <p class="mt-1 text-sm text-ink-soft">
        本地库 {DB_NAME} · 结构版本 v{DB_VERSION}
        {lastBackupAt ? `· 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : '· 尚未导出过备份'}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="gb-btn" onclick={() => void handleExport()}>导出 JSON</button>
      <button class="gb-btn" onclick={() => fileInput?.click()}>导入 JSON</button>
      <button class="gb-btn-danger" onclick={() => void handleReset()}>清空重播种</button>
      <button class="gb-btn-primary" onclick={openCreate}>加入印谱</button>
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json,.json"
        class="hidden"
        onchange={(event) => void handleImport(event)}
      />
    </div>
  </div>

  {#if toast}
    <div class="rounded-xl border px-4 py-2 text-sm {toastClass}">{toast.text}</div>
  {/if}

  {#if draft}
    <div class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          {#if draft.status === 'conflict'}
            <p class="font-semibold">检测到别处改动：{draft.conflictReason}。</p>
            <p class="mt-1 text-amber-700">排序草稿已保留，落点按当前印谱重算（新增条目在队尾）。请核对后保存，或放弃重新拖动。</p>
          {:else}
            <p class="font-semibold">有未保存的排序调整（仅改动受影响区段，尚未写入正式序号）。</p>
            <p class="mt-1 text-amber-700">保存时会先核对印谱版本；若另一标签页先动过，草稿会保留并自动重算落点。</p>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <button class="gb-btn" disabled={saving} onclick={discardDraft}>放弃调整</button>
          <button class="gb-btn-primary" disabled={saving} onclick={() => void saveOrder()}>
            {saving ? '保存中…' : '保存排序'}
          </button>
        </div>
      </div>
      {#if saveProgress}
        <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-amber-900/10">
          <span
            class="block h-full rounded-full bg-amber-600 transition-all"
            style="width: {saveProgress.total === 0
              ? 0
              : Math.round((saveProgress.done / saveProgress.total) * 100)}%"
          ></span>
        </div>
        <p class="mt-1 text-xs text-amber-700">正在分批写入 {saveProgress.done}/{saveProgress.total}…</p>
      {/if}
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="谱录条目" value={stat.total} suffix="方" tone="seal" />
    <StatBadge label="已收录" value={stat.included} suffix="方" tone="jade" />
    <StatBadge label="待收录" value={stat.pending} suffix="方" tone="amber" />
    <StatBadge label="不收录" value={stat.excluded} suffix="方" tone="ink" />
    <StatBadge label="待修条目" value={stat.broken} suffix="条" tone="seal" />
    <StatBadge label="钤印总数" value={$impressions.length} suffix="次" />
  </div>

  {#if board.valid.length === 0 && board.broken.length === 0}
    <EmptyPanel
      title="印谱还没有条目"
      description="把已完成的印稿加入印谱，拖动调整排序后点「保存排序」；引用不全的条目会先进入待修区。"
      actionText="加入印谱"
      onAction={openCreate}
    />
  {:else}
    {#if board.valid.length > 0}
      <div class="gb-panel overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th class="w-24">排序</th>
              <th>印文 / 释文</th>
              <th class="w-40">印石</th>
              <th class="w-32">状态</th>
              <th class="w-28">最佳评级</th>
              <th class="w-56">备注</th>
              <th class="w-52">操作</th>
            </tr>
          </thead>
          <tbody>
            {#each displayed as entry, index (entry.id)}
              {@const best = bestImpressionOf(entry.designId)}
              {@const previewNo = index + 1}
              {@const dirty = draft && draft.orderedIds[index] !== confirmed[index]?.id}
              <tr
                class="{dragId === entry.id ? 'opacity-50' : ''} {!saving ? 'cursor-grab' : ''}"
                draggable={!saving}
                ondragstart={() => (dragId = entry.id)}
                ondragover={(event) => {
                  if (!saving) event.preventDefault();
                }}
                ondrop={() => void handleDrop(entry.id)}
                ondragend={() => (dragId = '')}
              >
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-1">
                    {#if draft}
                      <span class="cursor-grab text-ink-soft" title="按住拖动调整顺序（保存后生效）">⋮⋮</span>
                      <span class="tabular-nums" title="保存后的正式序号">
                        {previewNo}{#if dirty}<span class="text-amber-600">*</span>{/if}
                      </span>
                    {:else}
                      <span class="tabular-nums">{entry.orderNo}</span>
                    {/if}
                    <button
                      class="gb-btn px-2 py-0.5"
                      disabled={index === 0 || saving}
                      onclick={() => void move(entry, -1)}
                    >
                      ↑
                    </button>
                    <button
                      class="gb-btn px-2 py-0.5"
                      disabled={index === displayed.length - 1 || saving}
                      onclick={() => void move(entry, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td>{designText(entry.designId)}</td>
                <td>{stoneText(entry.stoneId)}</td>
                <td>
                  <select
                    class="gb-input py-1"
                    style="color:{INCLUDED_COLOR[entry.included]}"
                    value={entry.included}
                    onchange={(event) =>
                      void setIncluded(entry, (event.currentTarget as HTMLSelectElement).value as IncludedStatus)}
                  >
                    {#each INCLUDED_OPTIONS as item (item.value)}
                      <option value={item.value}>{item.label}</option>
                    {/each}
                  </select>
                </td>
                <td>
                  {#if best}
                    <GradeTag grade={best.grade} size="small" />
                  {:else}
                    <span class="text-xs text-ink-soft">未钤印</span>
                  {/if}
                </td>
                <td>
                  <input
                    class="gb-input py-1"
                    value={entry.note}
                    placeholder="备注"
                    onchange={(event) => void saveNote(entry, (event.currentTarget as HTMLInputElement).value)}
                  />
                </td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    <button
                      class="gb-btn px-2 py-1"
                      onclick={() => void setIncluded(entry, entry.included === 'included' ? 'pending' : 'included')}
                    >
                      {entry.included === 'included' ? '取消收录' : '标记收录'}
                    </button>
                    <button class="gb-btn-danger px-2 py-1" onclick={() => (pendingDelete = entry)}>删除</button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if !draft}
        <p class="text-xs text-ink-soft">拖动行首 ⋮⋮（或用 ↑↓）开始排序：改动只暂存在本页草稿，点「保存排序」核对版本后分批写入正式序号。</p>
      {/if}
    {/if}

    {#if board.broken.length > 0}
      <section class="gb-panel space-y-2 border-seal/40">
        <h3 class="text-base text-seal">待修区（{board.broken.length}）</h3>
        <p class="text-sm text-ink-soft">
          以下条目引用不全，不占正式序号、不进印谱清单；请先补建被删的印石 / 印稿，或把条目移出印谱。
        </p>
        <ul class="divide-y divide-line">
          {#each board.broken as entry (entry.id)}
            <li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                {designText(entry.designId)}
                <span class="ml-2 text-xs text-seal">
                  {#if entry.missingStone && entry.missingDesign}印石与印稿均缺失
                  {:else if entry.missingStone}印石缺失{:else}印稿缺失{/if}
                </span>
              </span>
              <button class="gb-btn-danger px-2 py-1" onclick={() => (pendingDelete = entry)}>移出印谱</button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}

  <div class="grid gap-4 xl:grid-cols-2">
    <section class="gb-panel">
      <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">印谱清单</h3>
        <div class="flex flex-wrap gap-2">
          <button class="gb-btn" onclick={() => showToast(exportCatalogText(context), 'ok')}>导出清单</button>
          <button
            class="gb-btn"
            onclick={async () => {
              const ok = await copyText(catalogText);
              showToast(ok ? '印谱清单已复制到剪贴板' : '浏览器未授权剪贴板', ok ? 'ok' : 'warn');
            }}
          >
            复制
          </button>
        </div>
      </header>
      <p class="mb-2 text-xs text-ink-soft">清单始终按确认后的正式顺序展开；待修区与未保存的拖动调整不计入。</p>
      <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{catalogText}</pre>
    </section>

    <section class="gb-panel space-y-3">
      <h3 class="text-base text-ink">整库导出</h3>
      <p class="text-sm text-ink-soft">
        导出文件包含 5 张业务表全量数据与结构版本号（v{DB_VERSION}），可在其他设备通过「导入 JSON」还原。
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => void handleExport()}>JSON 备份</button>
        <button class="gb-btn" onclick={() => showToast(exportImpressionCsv(context), 'ok')}>钤印台账 CSV</button>
      </div>
      <div class="rounded-xl border border-line bg-black/[0.02] px-3 py-2 text-xs text-ink-soft">
        无状态容器：服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。
      </div>
      <dl class="grid grid-cols-2 gap-2 text-xs text-ink-soft">
        <div>印石 {$stones.length} 方</div>
        <div>印稿 {$designs.length} 稿</div>
        <div>工序 {$carves.length} 道</div>
        <div>钤印 {$impressions.length} 次</div>
      </dl>
    </section>
  </div>

  <p class="text-xs text-ink-soft">
    排序按区段排定：拖动只影响起止位置之间的序号，保存前核对印谱版本，正式序号分批推进；写入失败会恢复原顺序。
  </p>
</div>

{#if dialogOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">加入印谱</h3>
      <div class="space-y-3">
        <label class="block">
          <span class="gb-label">印石（仅显示尚有未收录印稿的印石）</span>
          <select class="gb-input" bind:value={newStoneId}>
            {#each $stones as stone (stone.id)}
              <option value={stone.id}>{stone.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="gb-label">印稿</span>
          <select class="gb-input" bind:value={newDesignId}>
            {#each designsOfNewStone as design (design.id)}
              <option value={design.id}>{design.sealText}（{design.annotation || '无释文'}）</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="gb-label">备注</span>
          <input class="gb-input" bind:value={newNote} placeholder="如：印谱首方" />
        </label>
        <p class="text-xs text-ink-soft">新条目追加到正式区末尾（第 {board.valid.length + 1} 位），默认状态为「待收录」。</p>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submitNew()}>加入</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">移出印谱</h3>
      <p class="mt-2 text-sm text-ink-soft">
        将把「{designText(pendingDelete.designId)}」移出印谱；正式区只重排受影响区段，印稿与钤印记录不受影响。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认移出</button>
      </div>
    </div>
  </div>
{/if}
