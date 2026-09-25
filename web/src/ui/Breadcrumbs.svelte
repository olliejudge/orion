<script lang="ts">
  import { crumbsSize, crumbsStart, type CrumbsSize, type CrumbsSlot } from "./models";
  import type { Crumb } from "./nav";

  interface Props {
    crumbs: Crumb[];
    /** Where the pill goes and how wide it may be (see crumbsSlot); null centres it on the viewport. */
    slot?: CrumbsSlot | null;
    /** Reports the pill's natural widths whenever they change (App places the pill from them). */
    onMeasure?: (size: CrumbsSize) => void;
    onSelect: (path: string) => void;
  }
  let { crumbs, slot = null, onMeasure, onSelect }: Props = $props();

  const CHROME = 14; // .crumbs padding (6px a side) and border (1px a side)

  // A hidden copy of the whole trail, plus a "…" crumb, measures each crumb's
  // natural width, so the pill can collapse its middle to fit its slot.
  let measure: HTMLOListElement;
  let widths: number[] = $state.raw([]);
  function remeasure(): void {
    const next = Array.from(measure.children, (el) => Math.ceil(el.getBoundingClientRect().width));
    if (next.length !== widths.length || next.some((w, i) => w !== widths[i])) widths = next;
  }
  $effect(() => {
    void crumbs; // new labels: measure them once they are in the DOM
    remeasure();
  });
  $effect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(remeasure); // e.g. once the font has loaded
    ro.observe(measure);
    return () => ro.disconnect();
  });

  const measured = $derived(widths.length === crumbs.length + 1);
  const trail = $derived(measured ? widths.slice(0, -1) : []);
  const ellipsis = $derived(measured ? widths[widths.length - 1]! : 0);
  $effect(() => {
    if (measured) onMeasure?.(crumbsSize(trail, ellipsis, CHROME));
  });
  const start = $derived(measured && slot ? crumbsStart(trail, ellipsis, CHROME, slot.maxWidth) : 1);
  // The deepest collapsed crumb: the "…" zooms there.
  const hidden = $derived(start > 1 ? crumbs[start - 1] : undefined);
</script>

{#snippet crumb(c: Crumb, i: number)}
  <li>
    {#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
    <button
      type="button"
      title={c.path === "" ? "Whole repository" : c.path}
      aria-current={i === crumbs.length - 1 ? "location" : undefined}
      onclick={() => onSelect(c.path)}><bdi>{c.label}</bdi></button>
  </li>
{/snippet}

<nav
  class="crumbs glass night-reveal"
  style:left={slot === null ? null : `${slot.x}px`}
  style:top={slot === null ? null : `${slot.top}px`}
  style:max-width={slot === null ? null : `${slot.maxWidth}px`}
  data-testid="breadcrumbs"
  aria-label="Map location">
  <ol>
    {#each crumbs as c, i (c.path)}
      {#if i === 0 || i >= start}
        {@render crumb(c, i)}
      {/if}
      {#if i === 0 && hidden}
        <li class="more">
          <span class="sep" aria-hidden="true">/</span>
          <button type="button" title={hidden.path} aria-label={hidden.path} onclick={() => onSelect(hidden.path)}>…</button>
        </li>
      {/if}
    {/each}
  </ol>
  <ol class="measure" aria-hidden="true" bind:this={measure}>
    {#each crumbs as c, i (c.path)}
      <li>{#if i > 0}<span class="sep">/</span>{/if}<span class="seg">{c.label}</span></li>
    {/each}
    <li><span class="sep">/</span><span class="seg">…</span></li>
  </ol>
</nav>

<style>
  .crumbs {
    position: fixed;
    left: 50%;
    top: var(--gutter);
    transform: translateX(-50%);
    /* Its own width, not the room left of `left`: near the right edge it would shrink. */
    width: max-content;
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
  .measure {
    position: absolute;
    top: 0;
    left: 0;
    width: max-content;
    visibility: hidden;
    pointer-events: none;
  }
  li {
    display: flex;
    align-items: center;
    min-width: 0;
    /* Middle segments truncate first, then the current folder; the repo name and the "…" keep their width. */
    flex-shrink: 1000;
  }
  li:last-child {
    flex-shrink: 1;
  }
  li:first-child,
  li.more,
  .measure li {
    flex: none;
  }
  .sep {
    padding: 0 1px;
    color: var(--text-faint);
  }
  button,
  .seg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 2px 7px;
    font-size: 11.5px;
    font-weight: 500;
  }
  button {
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  button:hover {
    background: var(--pill-bg-hover);
    color: var(--text);
  }
  button[aria-current="location"] {
    color: var(--text);
    /* The current folder ellipsizes at its start: the end of a path is the part that says where you are.
       Its label is a <bdi>, so the right-to-left box never reorders the path itself. */
    direction: rtl;
  }
</style>
