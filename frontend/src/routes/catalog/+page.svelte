<script lang="ts">
  /**
   * /catalog 印谱汇总与排序
   * 按区段排定（拖动只改受影响范围）、保存前核对版本号、别处先动过则留草稿并重算落点、
   * 正式序号分批推进、引用不全的条目先放待修区、写入失败恢复原顺序、大批量分批完成。
   * 消费 Catalog 及全部模型；复用 <StatBadge>、<EmptyPanel>、<GradeTag>。
   */
  import { onMount } from 'svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import GradeTag from '$lib/components/common/GradeTag.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { designs, loadDesigns } from '$lib/stores/designStore';
  import { carves, loadCarves } from '$lib/stores/carveStore';
  import { impressions, loadImpressions, bestImpressionOf } from '$lib/stores/impressionStore';
  import { loadStones, stones } from '$lib/stores/stoneStore';
  import {
    baseVersion,
    batchProgress,
    createEntry,
    discardDraft,
    hasConflict,
    hasDraft,
    initCatalogStore,
    moveEntry,
    orderedCatalog,
    pendingFixEntries,
    refreshCatalog,
    removeEntry,
    repairEntry,
    saveDraft,
    saveNote as saveNoteStore,
    saving,
    setIncluded as setIncludedStore,
    assignFormalNumbers,
  } from '$lib/stores/catalogStore';
  import {
    INCLUDED_COLOR,
    INCLUDED_OPTIONS,
    type Catalog,
    type IncludedStatus,
  } from '$lib/types/catalog';
  import {
    DB_NAME,
    DB_VERSION,
    exportSnapshot,
    importSnapshot,
    readLastBackupAt,
    resetDatabase,
    writeLastBackupAt,
  } from '$lib/utils/db';
  import { readCatalogVersion, writeCatalogVersion } from '$lib/utils/catalogOrder';
  import {
    buildCatalogText,
    copyText,
    exportCatalogText,
    exportImpressionCsv,
    exportSnapshotJson,
    validateSnapshot,
  } from '$lib/utils/export';
  import type { SealCarveSnapshot } from '$lib/utils/db';

  let fileInput = $state<HTMLInputElement | null>(null);
  let lastBackupAt = $state<string | null>(readLastBackupAt());
  let toast = $state('');
  let pendingDelete = $state<Catalog | null>(null);
  let dialogOpen = $state(false);
  let newStoneId = $state('');
  let newDesignId = $state('');
  let newNote = $state('');
  let dragId = $state('');
  let repairing = $state<Catalog | null>(null);
  let repairStoneId = $state('');
  let repairDesignId = $state('');

  onMount(() => {
    void initCatalogStore();
  });

  const ordered = $derived($orderedCatalog);
  const pendingFix = $derived($pendingFixEntries);

  const context = $derived({
    stones: $stones,
    designs: $designs,
    carves: $carves,
    impressions: $impressions,
    catalogs: ordered,
  });

  const catalogText = $derived(buildCatalogText(context));

  const stat = $derived({
    total: ordered.length,
    included: ordered.filter((item) => item.included === 'included').length,
    pending: ordered.filter((item) => item.included === 'pending').length,
    excluded: ordered.filter((item) => item.included === 'excluded').length,
  });

  const unlistedDesigns = $derived(
    $designs.filter((design) => !ordered.some((item) => item.designId === design.id)),
  );
  const designsOfNewStone = $derived(unlistedDesigns.filter((design) => design.stoneId === newStoneId));
  const designsOfRepairStone = $derived(
    $designs.filter((design) => design.stoneId === repairStoneId),
  );

  $effect(() => {
    if (newStoneId.length === 0 && $stones.length > 0) newStoneId = $stones[0]?.id ?? '';
  });

  $effect(() => {
    const first = designsOfNewStone[0];
    if (first && !designsOfNewStone.some((design) => design.id === newDesignId)) newDesignId = first.id;
  });

  $effect(() => {
    const first = designsOfRepairStone[0];
    if (first && !designsOfRepairStone.some((design) => design.id === repairDesignId)) {
      repairDesignId = first.id;
    }
  });

  function designText(designId: string): string {
    const design = $designs.find((item) => item.id === designId);
    return design ? `${design.sealText}（${design.annotation || '无释文'}）` : '（印稿已删除）';
  }

  function stoneText(stoneId: string): string {
    return $stones.find((stone) => stone.id === stoneId)?.name ?? '（印石已删除）';
  }

  function showToast(text: string): void {
    toast = text;
    setTimeout(() => (toast = ''), 2600);
  }

  function move(entry: Catalog, delta: number): void {
    const list = ordered;
    const index = list.findIndex((item) => item.id === entry.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    moveEntry(entry.id, list[target].id);
  }

  function handleDrop(targetId: string): void {
    if (!dragId || dragId === targetId) {
      dragId = '';
      return;
    }
    moveEntry(dragId, targetId);
    dragId = '';
  }

  async function setIncluded(entry: Catalog, included: IncludedStatus): Promise<void> {
    await setIncludedStore(entry.id, included);
  }

  async function saveNote(entry: Catalog, note: string): Promise<void> {
    await saveNoteStore(entry.id, note);
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    await removeEntry(pendingDelete.id);
    pendingDelete = null;
    showToast('已删除并重编号');
  }

  function openCreate(): void {
    if (unlistedDesigns.length === 0) {
      showToast('所有印稿都已进入印谱');
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
    await createEntry(design.stoneId, design.id, newNote);
    dialogOpen = false;
    showToast(`已加入印谱：${design.sealText}`);
  }

  function openRepair(entry: Catalog): void {
    repairing = entry;
    repairStoneId = entry.stoneId || $stones[0]?.id || '';
    repairDesignId = entry.designId || '';
  }

  async function submitRepair(): Promise<void> {
    if (!repairing) return;
    await repairEntry(repairing.id, repairStoneId, repairDesignId);
    repairing = null;
    showToast('条目已修复');
  }

  async function handleSaveDraft(): Promise<void> {
    await saveDraft();
    if ($hasConflict) {
      showToast('印谱已在别处修改，已保留草稿并重算落点');
    } else {
      showToast('排序已保存');
    }
  }

  function handleDiscardDraft(): void {
    discardDraft();
    showToast('已放弃草稿，恢复原顺序');
  }

  async function handleAssignFormalNumbers(): Promise<void> {
    await assignFormalNumbers();
    showToast('正式编号已完成');
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
      showToast('JSON 解析失败，请确认文件格式');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      showToast(invalid);
      return;
    }
    if (!window.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，操作不可撤销。是否继续？')) return;
    await importSnapshot(parsed as SealCarveSnapshot);
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), refreshCatalog()]);
    showToast('导入完成，数据已覆盖');
  }

  async function handleReset(): Promise<void> {
    if (!window.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。是否继续？')) return;
    await resetDatabase();
    writeCatalogVersion(readCatalogVersion() + 1);
    baseVersion.set(readCatalogVersion());
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), refreshCatalog()]);
    showToast('已清空并重新载入演示数据');
  }
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
      <button class="gb-btn" onclick={() => void handleAssignFormalNumbers()} disabled={$saving}>正式编号</button>
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
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{toast}</div>
  {/if}

  {#if $hasConflict}
    <div class="rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">
      印谱已在别处修改，已保留草稿并重算落点。请确认顺序后保存。
    </div>
  {:else if $hasDraft}
    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-amber/40 bg-amber/10 px-4 py-2 text-sm text-amber">
      <span>有未保存的排序草稿（仅改受影响范围）。</span>
      <button class="gb-btn px-2 py-0.5" onclick={() => void handleSaveDraft()} disabled={$saving}>保存草稿</button>
      <button class="gb-btn px-2 py-0.5" onclick={handleDiscardDraft} disabled={$saving}>放弃草稿</button>
    </div>
  {/if}

  {#if $batchProgress}
    <div class="rounded-xl border border-line bg-paper-light px-4 py-2 text-sm text-ink-soft">
      正在分批处理：{$batchProgress.current} / {$batchProgress.total}
      <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
        <div
          class="h-full rounded-full bg-seal transition-all"
          style="width:{$batchProgress.total === 0 ? 0 : ($batchProgress.current / $batchProgress.total) * 100}%"
        ></div>
      </div>
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="谱录条目" value={stat.total} suffix="方" tone="seal" />
    <StatBadge label="已收录" value={stat.included} suffix="方" tone="jade" />
    <StatBadge label="待收录" value={stat.pending} suffix="方" tone="amber" />
    <StatBadge label="不收录" value={stat.excluded} suffix="方" tone="ink" />
    <StatBadge label="待修" value={pendingFix.length} suffix="方" tone="amber" />
    <StatBadge label="钤印总数" value={$impressions.length} suffix="次" />
  </div>

  {#if ordered.length === 0}
    <EmptyPanel
      title="印谱还没有条目"
      description="把已完成的印稿加入印谱，调整排序与收录状态，即可导出印谱清单与 JSON 备份。"
      actionText="加入印谱"
      onAction={openCreate}
    />
  {:else}
    <div class="gb-panel overflow-x-auto">
      <table class="gb-table">
        <thead>
          <tr>
            <th class="w-20">排序</th>
            <th>印文 / 释文</th>
            <th class="w-40">印石</th>
            <th class="w-32">状态</th>
            <th class="w-28">最佳评级</th>
            <th class="w-56">备注</th>
            <th class="w-52">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each ordered as entry, index (entry.id)}
            {@const best = bestImpressionOf(entry.designId)}
            <tr
              class="{dragId === entry.id ? 'opacity-50' : ''} {$hasDraft ? 'bg-amber/5' : ''}"
              draggable="true"
              ondragstart={() => (dragId = entry.id)}
              ondragover={(event) => event.preventDefault()}
              ondrop={() => handleDrop(entry.id)}
            >
              <td class="whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <span class="cursor-grab text-ink-soft" title="按住拖动可调整顺序">⋮⋮</span>
                  <span class="tabular-nums">{entry.orderNo}</span>
                  <button class="gb-btn px-2 py-0.5" disabled={index === 0} onclick={() => move(entry, -1)}>↑</button>
                  <button
                    class="gb-btn px-2 py-0.5"
                    disabled={index === ordered.length - 1}
                    onclick={() => move(entry, 1)}
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
  {/if}

  {#if pendingFix.length > 0}
    <section class="gb-panel border-amber/40">
      <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-amber">待修区（{pendingFix.length} 方 · 引用不完整，不参与排序）</h3>
      </header>
      <div class="overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th>印文 / 释文</th>
              <th class="w-40">印石</th>
              <th class="w-40">问题</th>
              <th class="w-40">操作</th>
            </tr>
          </thead>
          <tbody>
            {#each pendingFix as entry (entry.id)}
              <tr>
                <td>{designText(entry.designId)}</td>
                <td>{stoneText(entry.stoneId)}</td>
                <td class="text-xs text-amber">
                  {#if !$stones.some((s) => s.id === entry.stoneId) && !$designs.some((d) => d.id === entry.designId)}
                    印石与印稿均已删除
                  {:else if !$stones.some((s) => s.id === entry.stoneId)}
                    印石已删除
                  {:else}
                    印稿已删除
                  {/if}
                </td>
                <td>
                  <div class="flex flex-wrap gap-1">
                    <button class="gb-btn px-2 py-1" onclick={() => openRepair(entry)}>修复</button>
                    <button
                      class="gb-btn-danger px-2 py-1"
                      onclick={async () => {
                        await removeEntry(entry.id);
                        showToast('已删除待修条目');
                      }}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <div class="grid gap-4 xl:grid-cols-2">
    <section class="gb-panel">
      <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">印谱清单</h3>
        <div class="flex flex-wrap gap-2">
          <button class="gb-btn" onclick={() => showToast(exportCatalogText(context))}>导出清单</button>
          <button
            class="gb-btn"
            onclick={async () => {
              const ok = await copyText(catalogText);
              showToast(ok ? '印谱清单已复制到剪贴板' : '浏览器未授权剪贴板');
            }}
          >
            复制
          </button>
        </div>
      </header>
      <pre class="max-h-[360px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">{catalogText}</pre>
    </section>

    <section class="gb-panel space-y-3">
      <h3 class="text-base text-ink">整库导出</h3>
      <p class="text-sm text-ink-soft">
        导出文件包含 5 张业务表全量数据与结构版本号（v{DB_VERSION}），可在其他设备通过「导入 JSON」还原。
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => void handleExport()}>JSON 备份</button>
        <button class="gb-btn" onclick={() => showToast(exportImpressionCsv(context))}>钤印台账 CSV</button>
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
    拖动或上下移仅调整受影响范围（from 与 to 之间），保存前核对印谱版本号；别处先动过则保留草稿并重算落点。正式序号分批推进，引用不完整的条目先放待修区。写入失败自动恢复原顺序。
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
        <p class="text-xs text-ink-soft">新条目将追加到第 {ordered.length + 1} 位，默认状态为「待收录」。</p>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submitNew()}>加入</button>
      </div>
    </div>
  </div>
{/if}

{#if repairing}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">修复待修条目</h3>
      <p class="mb-3 text-sm text-ink-soft">
        该条目的印石或印稿引用已失效，请重新指定有效引用。
      </p>
      <div class="space-y-3">
        <label class="block">
          <span class="gb-label">印石</span>
          <select class="gb-input" bind:value={repairStoneId}>
            {#each $stones as stone (stone.id)}
              <option value={stone.id}>{stone.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="gb-label">印稿</span>
          <select class="gb-input" bind:value={repairDesignId}>
            {#each designsOfRepairStone as design (design.id)}
              <option value={design.id}>{design.sealText}（{design.annotation || '无释文'}）</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (repairing = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submitRepair()}>确认修复</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除谱录条目</h3>
      <p class="mt-2 text-sm text-ink-soft">
        将把「{designText(pendingDelete.designId)}」移出印谱，其余条目分批重编号；印稿与钤印记录不受影响。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
