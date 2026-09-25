<script lang="ts">
  import { ancestorExcluded, isExcluded, loadDirFilterOpen, saveDirFilterOpen, toggled, type DirEntry } from "../layout/exclude";
  import type { Footprint } from "./models";

  interface Props {
    /** Every directory currently in the repo (base ∪ overlays), unfiltered by `excluded`. */
    dirs: DirEntry[];
    /** The directories currently hidden from the map. */
    excluded: ReadonlySet<string>;
    /** Called with the next set whenever a checkbox or "Show all" changes it. */
    onChange: (next: Set<string>) => void;
    /** Reports the panel's size whenever it changes (the map keeps clear of it). */
    onFootprint?: (size: Footprint) => void;
    /** Extra px to lift the panel above the gutter, e.g. clear of the map key stacked below it. */
    lift?: number;
    /** Where the open/closed choice is remembered (defaults to localStorage). */
    storage?: Storage | null;
  }
  let { dirs, excluded, onChange, onFootprint, lift = 0, storage }: Props = $props();

  const uid = $props.id();
  // Read once, on mount: afterwards `open` is the panel's own state (see MapKey).
  // svelte-ignore state_referenced_locally
  let open = $state(loadDirFilterOpen(storage, false));
  // Expand state is ephemeral (not persisted): the top level starts open,
  // deeper levels start collapsed. Toggling a top-level row records it as
  // manually *closed*; toggling a deeper row records it as manually *open*.
  let closedTop = $state<ReadonlySet<string>>(new Set());
  let openDeep = $state<ReadonlySet<string>>(new Set());

  let panel: HTMLElement;
  $effect(() => {
    const report = onFootprint;
    if (!report || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => report({ width: panel.offsetWidth, height: panel.offsetHeight }));
    ro.observe(panel);
    return () => ro.disconnect();
  });

  function toggleOpenPanel(): void {
    open = !open;
    saveDirFilterOpen(open, storage);
  }

  function isExpanded(path: string, depth: number): boolean {
    return depth === 0 ? !closedTop.has(path) : openDeep.has(path);
  }

  function toggleExpanded(path: string, depth: number): void {
    if (depth === 0) closedTop = toggled(closedTop, path);
    else openDeep = toggled(openDeep, path);
  }

  function toggleHidden(path: string): void {
    onChange(toggled(excluded, path));
  }

  function showAll(): void {
    onChange(new Set());
  }
</script>

{#snippet row(node: DirEntry, depth: number)}
  {@const hidden = isExcluded(node.path, excluded)}
  {@const inherited = hidden && ancestorExcluded(node.path, excluded)}
  {@const hasKids = node.children.length > 0}
  {@const expanded = hasKids && isExpanded(node.path, depth)}
  {@const rowsId = `${uid}-kids-${node.path}`}
  {@const inputId = `${uid}-cb-${node.path}`}
  <li>
    <div class="row" style:padding-left={`${depth * 14 + 4}px`}>
      {#if hasKids}
        <button
          type="button"
          class="caret"
          aria-expanded={expanded}
          aria-controls={rowsId}
          title={expanded ? "Collapse" : "Expand"}
          onclick={() => toggleExpanded(node.path, depth)}>
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" class:down={expanded}>
            <path d="M2.75 1.5 5.25 4l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {:else}
        <span class="caret-spacer" aria-hidden="true"></span>
      {/if}
      <input id={inputId} type="checkbox" checked={!hidden} disabled={inherited} onchange={() => toggleHidden(node.path)} />
      <label for={inputId} class:disabled={inherited} title={node.path}>{node.name}</label>
    </div>
    {#if hasKids && expanded}
      <ul id={rowsId}>
        {#each node.children as child (child.path)}
          {@render row(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<section class="dirfilter glass" class:open data-testid="dir-filter" aria-label="Folders shown on the map" bind:this={panel} style:--lift={`${lift}px`}>
  <button
    type="button"
    class="toggle"
    aria-expanded={open}
    aria-controls={`${uid}-tree`}
    title={open ? "Hide the folder filter" : "Choose which folders show on the map"}
    onclick={toggleOpenPanel}>
    Folders
    {#if excluded.size > 0}
      <span class="badge">{excluded.size} hidden</span>
    {/if}
    <svg class="chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1.5 5.25 4 2.75l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <div class="body" id={`${uid}-tree`} hidden={!open}>
    <div class="head">
      <button type="button" class="show-all" disabled={excluded.size === 0} onclick={showAll}>Show all</button>
    </div>
    {#if dirs.length === 0}
      <p class="empty">No folders yet.</p>
    {:else}
      <ul class="tree">
        {#each dirs as d (d.path)}
          {@render row(d, 0)}
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  /* Bottom-left, stacked above the map key (App.svelte sets --lift to its height). */
  .dirfilter {
    position: fixed;
    left: var(--gutter);
    bottom: calc(var(--gutter) + var(--lift, 0px));
    box-sizing: border-box;
    max-width: calc(100vw - 2 * var(--gutter));
    padding: 3px;
    border-radius: 999px;
    z-index: 2;
  }
  .dirfilter.open {
    width: 240px;
    padding: 6px 8px 8px;
    border-radius: var(--radius-panel);
  }
  @media (max-width: 720px) {
    .dirfilter.open {
      z-index: 3;
      background: rgba(24, 24, 32, 0.97);
    }
    :global(:root[data-theme="night"]) .dirfilter.open {
      background: rgba(0, 0, 0, 0.94);
      border-color: var(--pill-border);
    }
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .open .toggle {
    margin: 0 0 4px -8px;
  }
  .toggle:hover {
    color: var(--text);
    background: var(--pill-bg-hover);
  }
  .badge {
    padding: 0 5px;
    border-radius: 999px;
    background: var(--pill-bg-on);
    color: var(--text);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .chevron {
    transition: transform 0.15s ease;
  }
  .open .chevron {
    transform: rotate(180deg);
  }
  .body {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .head {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 4px;
  }
  .show-all {
    padding: 2px 6px;
    border: 0;
    border-radius: var(--radius-row);
    background: none;
    color: var(--text-dim);
    font-size: 10.5px;
    cursor: pointer;
  }
  .show-all:hover:not(:disabled) {
    color: var(--text);
    background: var(--pill-bg-hover);
  }
  .show-all:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .empty {
    margin: 2px 4px;
    color: var(--text-faint);
    font-size: 11px;
  }
  .tree,
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tree {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    /* Header + toggle + gutters roughly account for 96px; --lift stacks another panel below. */
    max-height: calc(100vh - 2 * var(--gutter) - 96px - var(--lift, 0px));
    margin: 0 -4px;
    padding: 0 4px 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    font-size: 11.5px;
  }
  .caret,
  .caret-spacer {
    flex: none;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .caret {
    border: 0;
    padding: 0;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .caret:hover {
    color: var(--text);
  }
  .caret svg {
    transition: transform 0.15s ease;
  }
  .caret svg.down {
    transform: rotate(90deg);
  }
  input[type="checkbox"] {
    flex: none;
    margin: 0;
  }
  label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  label.disabled {
    color: var(--text-faint);
    cursor: default;
  }

  :global(:root[data-theme="night"]) .dirfilter {
    text-shadow:
      0 0 2px #000,
      0 0 8px #000;
  }
  :global(:root[data-theme="night"]) .body {
    opacity: 0.55;
    transition: opacity 0.25s ease;
  }
  :global(:root[data-theme="night"]) .dirfilter:hover .body,
  :global(:root[data-theme="night"]) .dirfilter:focus-within .body {
    opacity: 1;
  }
</style>
