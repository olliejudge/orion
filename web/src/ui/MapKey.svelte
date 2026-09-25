<script lang="ts">
  import { lighten, type ExtColor } from "../colors";
  import type { Theme } from "../render/style";
  import { SWATCH_H, SWATCH_W, hexOf, keyEntries, loadKeyOpen, saveKeyOpen, type KeyMark } from "./encodingKey";
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

  function sphere(m: KeyMark): ExtColor | null {
    const b = m.look.body;
    if (b?.kind === "ext") return b.color;
    if (b?.kind === "worktree") return { light: lighten(b.color, 0.45), base: b.color };
    return null;
  }
</script>

{#snippet swatch(marks: KeyMark[], id: string)}
  <svg class="swatch" width={SWATCH_W} height={SWATCH_H} viewBox={`0 0 ${SWATCH_W} ${SWATCH_H}`} aria-hidden="true">
    {#each marks as m, i (i)}
      {@const cy = SWATCH_H / 2}
      {@const sph = sphere(m)}
      {@const body = m.look.body}
      {@const halo = m.look.halo}
      {@const o = m.look.outline}
      {@const gid = `${uid}-${id}-${i}`}
      <defs>
        {#if sph}
          <!-- The sphere texture's gradient: centred at 35%/30%, radius half the box. -->
          <radialGradient id={`${gid}-body`} cx="35%" cy="30%" r="50%">
            <stop offset="0" stop-color={sph.light} />
            <stop offset="1" stop-color={sph.base} />
          </radialGradient>
        {/if}
        {#if halo}
          <radialGradient id={`${gid}-halo`}>
            <stop offset="0.4" stop-color={hexOf(halo.color)} stop-opacity="0" />
            <stop offset={HALO_RING_FRAC} stop-color={hexOf(halo.color)} stop-opacity="0.9" />
            <stop offset="1" stop-color={hexOf(halo.color)} stop-opacity="0" />
          </radialGradient>
        {/if}
      </defs>
      {#if halo}
        <circle cx={m.cx} {cy} r={(m.r + HALO_PX) / HALO_RING_FRAC} fill={`url(#${gid}-halo)`} opacity={halo.alpha} />
      {/if}
      {#if body}
        <circle
          class="body"
          data-kind={body.kind}
          cx={m.cx}
          {cy}
          r={m.r}
          fill={sph ? `url(#${gid}-body)` : body.kind === "flat" ? hexOf(body.tint) : "none"}
          opacity={body.alpha} />
      {/if}
      {#if o}
        {#if o.fillAlpha > 0}<circle cx={m.cx} {cy} r={m.r} fill={hexOf(o.fill)} opacity={o.fillAlpha} />{/if}
        <circle
          class="outline"
          cx={m.cx}
          {cy}
          r={m.r}
          fill="none"
          stroke={hexOf(o.color)}
          stroke-opacity={o.alpha}
          stroke-width="1"
          stroke-dasharray={o.dashed ? "2 2" : undefined} />
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
    </ul>
    <p class="note">Circles are folders. Colours are worktrees; a split ring means several.</p>
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
