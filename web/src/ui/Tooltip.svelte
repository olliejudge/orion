<script lang="ts">
  import { tooltipPosition, type TooltipInfo } from "./models";

  let { info, x, y }: { info: TooltipInfo | null; x: number; y: number } = $props();

  let viewportW = $state(typeof window === "undefined" ? 1024 : window.innerWidth);
  let viewportH = $state(typeof window === "undefined" ? 768 : window.innerHeight);
  let tipW = $state(0);
  let tipH = $state(0);
  const pos = $derived(tooltipPosition(x, y, tipW, tipH, viewportW, viewportH));
</script>

<svelte:window bind:innerWidth={viewportW} bind:innerHeight={viewportH} />

{#if info}
  <div
    class="tip glass"
    role="tooltip"
    data-testid="tooltip"
    style:left={`${pos.left}px`}
    style:top={`${pos.top}px`}
    bind:offsetWidth={tipW}
    bind:offsetHeight={tipH}
  >
    <div class="path"><span class="dir">{info.dir}</span><span class="name">{info.name}</span></div>
    <div class="detail">{info.detail}</div>
    {#if info.touches.length > 0}
      <ul>
        {#each info.touches as t, i (i)}
          <li><span class="dot" style:background={t.color}></span><span class="who">{t.label}</span><span class="what">{t.text}</span></li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    width: max-content;
    max-width: 280px;
    padding: 8px 10px;
    pointer-events: none;
    z-index: 3;
    /* More opaque than the panels: it often sits over panel text. */
    background: rgba(30, 30, 40, 0.82);
  }
  :global(:root[data-theme="night"]) .tip {
    background: rgba(20, 20, 24, 0.92);
    border-color: rgba(255, 255, 255, 0.08);
  }
  .path {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .dir {
    color: var(--text-dim);
  }
  .detail {
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11.5px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    align-self: center;
  }
  .what {
    color: var(--text-dim);
  }
</style>
