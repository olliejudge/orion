<script lang="ts">
  import { DELETED_RIM_W_PX, GLYPH_ARM, GLYPH_STROKE, type Theme } from "../render/style";
  import { SWATCH_H, SWATCH_W, countSwatch, hexOf, keyEntries, loadKeyOpen, saveKeyOpen, type KeyMark } from "./encodingKey";
  import type { Footprint } from "./models";

  interface Props {
    theme: Theme;
    /** Reports the panel's size whenever it changes (the map keeps clear of it). */
    onFootprint?: (size: Footprint) => void;
    /** Where the open/closed choice is remembered (defaults to localStorage). */
    storage?: Storage | null;
  }
  let { theme, onFootprint, storage }: Props = $props();

  const uid = $props.id();
  // Read once, on mount: afterwards `open` is the panel's own state. An
  // undefined `storage` falls back to localStorage (the helpers' default).
  // A first visit on a narrow screen starts collapsed: open, the key would
  // cover the activity sheet there.
  const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 720px)").matches;
  // svelte-ignore state_referenced_locally
  let open = $state(loadKeyOpen(storage, !narrow));
  const entries = $derived(keyEntries(theme));
  const counted = $derived(countSwatch(theme));

  // Mirrors the renderer's halo sprite (sprites.ts HALO_RING_FRAC; MapRenderer
  // HALO_PX), scaled down so a swatch's glow stays inside its row.
  const HALO_RING_FRAC = 0.7;
  const HALO_PX = 3.5;

  let panel: HTMLElement;
  $effect(() => {
    const report = onFootprint;
    if (!report || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => report({ width: panel.offsetWidth, height: panel.offsetHeight }));
    ro.observe(panel);
    return () => ro.disconnect();
  });

  function toggle(): void {
    open = !open;
    saveKeyOpen(open, storage);
  }

  /** The glyph texture's strokes (sprites.ts), centred at (cx, cy) with half-size h. */
  function glyphPath(cx: number, cy: number, h: number): string {
    const arm = GLYPH_ARM * h;
    return `M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}`;
  }
</script>

{#snippet swatch(marks: KeyMark[], id: string)}
  <svg class="swatch" width={SWATCH_W} height={SWATCH_H} viewBox={`0 0 ${SWATCH_W} ${SWATCH_H}`} aria-hidden="true">
    {#each marks as m, i (i)}
      {@const cy = SWATCH_H / 2}
      {@const body = m.look.body}
      {@const halo = m.look.halo}
      {@const o = m.look.outline}
      {@const glyph = m.look.glyph}
      {@const gid = `${uid}-${id}-${i}`}
      {#if halo}
        <defs>
          <radialGradient id={`${gid}-halo`}>
            <stop offset="0.4" stop-color={hexOf(halo.color)} stop-opacity="0" />
            <stop offset={HALO_RING_FRAC} stop-color={hexOf(halo.color)} stop-opacity="0.9" />
            <stop offset="1" stop-color={hexOf(halo.color)} stop-opacity="0" />
          </radialGradient>
        </defs>
        <circle cx={m.cx} {cy} r={(m.r + HALO_PX) / HALO_RING_FRAC} fill={`url(#${gid}-halo)`} opacity={halo.alpha} />
      {/if}
      {#if body}
        <circle class="body" cx={m.cx} {cy} r={m.r} fill={hexOf(body.tint)} opacity={body.alpha} />
      {/if}
      <!-- Rim and rings age together, as the map sets their alpha as a group. -->
      <g opacity={m.look.marks}>
        {#if o}
          <circle
            class="outline"
            cx={m.cx}
            {cy}
            r={m.r - DELETED_RIM_W_PX / 2}
            fill="none"
            stroke={hexOf(o.color)}
            stroke-opacity={o.alpha}
            stroke-width={DELETED_RIM_W_PX} />
        {/if}
        {#each m.look.rings.arcs as a, j (j)}
          <circle
            class="ring"
            data-dashed={a.dashed}
            cx={m.cx}
            {cy}
            r={m.r + m.look.rings.gap}
            fill="none"
            stroke={hexOf(a.color)}
            stroke-opacity={a.alpha}
            stroke-width={m.look.rings.width}
            stroke-dasharray={a.dashed ? "4 3" : undefined} />
        {/each}
      </g>
      {#if glyph && m.glyph !== null}
        <path
          class="glyph"
          data-shape={glyph.shape}
          d={glyphPath(m.cx, cy, m.glyph)}
          transform={glyph.shape === "cross" ? `rotate(45 ${m.cx} ${cy})` : undefined}
          fill="none"
          stroke={hexOf(glyph.color)}
          stroke-opacity={glyph.alpha}
          stroke-width={GLYPH_STROKE * m.glyph}
          stroke-linecap="round" />
      {/if}
      {#if m.shimmer}<circle class="flash" cx={m.cx} {cy} r={m.r} fill="#fff" />{/if}
    {/each}
  </svg>
{/snippet}

<section class="key glass" class:open data-testid="map-key" aria-label="Map key" bind:this={panel}>
  <button
    type="button"
    class="toggle"
    aria-expanded={open}
    aria-controls={`${uid}-rows`}
    title={open ? "Hide the map key" : "Show what the marks on the map mean"}
    onclick={toggle}>
    Key
    <svg class="chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1.5 5.25 4 2.75l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <div class="rows" id={`${uid}-rows`} hidden={!open}>
    <ul>
      {#each entries as e (e.id)}
        <li data-testid="map-key-entry" data-entry={e.id} title={e.hint}>
          {@render swatch(e.marks, e.id)}
          <span>{e.label}</span>
        </li>
      {/each}
      <li data-testid="map-key-entry" data-entry="collapsed" title={counted.hint}>
        <svg class="swatch" width={SWATCH_W} height={SWATCH_H} viewBox={`0 0 ${SWATCH_W} ${SWATCH_H}`} aria-hidden="true">
          <circle
            class="disc"
            cx={SWATCH_W / 2}
            cy={SWATCH_H / 2}
            r={counted.r}
            fill={hexOf(counted.fill.color)}
            fill-opacity={counted.fill.alpha}
            stroke={hexOf(counted.outline.color)}
            stroke-opacity={counted.outline.alpha}
            stroke-width="1" />
          <text
            class="count"
            x={SWATCH_W / 2}
            y={SWATCH_H / 2}
            fill={counted.color}
            font-size={counted.font}
            font-weight="500"
            text-anchor="middle"
            dominant-baseline="central">{counted.count}</text>
        </svg>
        <span>{counted.label}</span>
      </li>
    </ul>
    <p class="note">Circles are folders. Colours are worktrees; a split ring means several. Brightness is recency.</p>
    <p class="note">Click: in one level · Double-click: straight in · Scroll: zoom · Esc: out · 0: home</p>
  </div>
</section>

<style>
  /* Bottom-left, the one corner the rest of the chrome leaves free. */
  .key {
    position: fixed;
    left: var(--gutter);
    bottom: var(--gutter);
    box-sizing: border-box;
    max-width: calc(100vw - 2 * var(--gutter));
    padding: 3px;
    border-radius: 999px;
    z-index: 2;
  }
  .key.open {
    width: 196px;
    padding: 6px 10px 10px;
    border-radius: var(--radius-panel);
  }
  /* Narrow: open, it overlaps the activity sheet, so it sits on top of it
     as an opaque popover rather than letting the sheet's text show through. */
  @media (max-width: 720px) {
    .key.open {
      z-index: 3;
      background: rgba(24, 24, 32, 0.97);
    }
    :global(:root[data-theme="night"]) .key.open {
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
  /* Points the way the key opens: up when collapsed, down to fold it away. */
  .chevron {
    transition: transform 0.15s ease;
  }
  .open .chevron {
    transform: rotate(180deg);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 22px;
    font-size: 11.5px;
    white-space: nowrap;
  }
  .swatch {
    flex: none;
    overflow: visible;
  }
  .note {
    margin: 6px 0 0;
    color: var(--text-faint);
    font-size: 10.5px;
    line-height: 1.4;
    text-wrap: pretty;
  }

  /* The merge shimmer: a still highlight (as with reduced motion) until the
     pointer or focus is on the key, then the map's pulse (600 ms, peak 0.55,
     growing a quarter) on a loop. */
  .flash {
    opacity: 0.3;
    transform-box: fill-box;
    transform-origin: center;
  }
  @media (prefers-reduced-motion: no-preference) {
    .key:hover .flash,
    .key:focus-within .flash {
      animation: shimmer 2.4s ease-out infinite;
    }
  }
  @keyframes shimmer {
    0% {
      opacity: 0;
      transform: scale(1);
    }
    12.5% {
      opacity: 0.55;
      transform: scale(1.125);
    }
    25%,
    100% {
      opacity: 0;
      transform: scale(1.25);
    }
  }

  /* Night: no panel, so the text keeps a shadow over the bubbles, and the rows
     stay dim until the pointer (or focus) visits the key. */
  :global(:root[data-theme="night"]) .key {
    text-shadow:
      0 0 2px #000,
      0 0 8px #000;
  }
  :global(:root[data-theme="night"]) .rows {
    opacity: 0.55;
    transition: opacity 0.25s ease;
  }
  :global(:root[data-theme="night"]) .key:hover .rows,
  :global(:root[data-theme="night"]) .key:focus-within .rows {
    opacity: 1;
  }
</style>
