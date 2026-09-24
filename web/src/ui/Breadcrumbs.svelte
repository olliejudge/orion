<script lang="ts">
  import type { Crumb } from "./nav";

  // centerX: where the map's free area is centred (CSS px); null centres on the viewport.
  let {
    crumbs,
    centerX = null,
    onSelect,
  }: { crumbs: Crumb[]; centerX?: number | null; onSelect: (path: string) => void } = $props();
</script>

<nav
  class="crumbs glass night-reveal"
  style:left={centerX === null ? null : `${centerX}px`}
  data-testid="breadcrumbs"
  aria-label="Map location">
  <ol>
    {#each crumbs as c, i (c.path)}
      <li>
        {#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
        <button
          type="button"
          title={c.path === "" ? "Whole repository" : c.path}
          aria-current={i === crumbs.length - 1 ? "location" : undefined}
          onclick={() => onSelect(c.path)}>{c.label}</button>
      </li>
    {/each}
  </ol>
</nav>

<style>
  .crumbs {
    position: fixed;
    left: 50%;
    top: var(--gutter);
    transform: translateX(-50%);
    max-width: min(560px, calc(100vw - 2 * var(--gutter)));
    box-sizing: border-box;
    padding: 3px 6px;
    border-radius: 999px;
    z-index: 2;
  }
  ol {
    display: flex;
    align-items: center;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    white-space: nowrap;
  }
  li {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  /* The repo name and the current folder keep their width; middle segments truncate first. */
  li:first-child,
  li:last-child {
    flex-shrink: 0;
  }
  .sep {
    padding: 0 1px;
    color: var(--text-faint);
  }
  button {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 2px 7px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover {
    background: var(--pill-bg-hover);
    color: var(--text);
  }
  button[aria-current="location"] {
    color: var(--text);
  }
</style>
