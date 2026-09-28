<script lang="ts">
  import { VIEW_KINDS, VIEW_LABELS, type ViewKind } from "../render/view";

  // centerX: where the map's free area is centred (CSS px), as for the Live pill; null centres on the viewport.
  let { view, centerX = null, onSelect }: { view: ViewKind; centerX?: number | null; onSelect: (v: ViewKind) => void } = $props();
</script>

<div class="switch glass" style:left={centerX === null ? null : `${centerX}px`} role="radiogroup" aria-label="Map view" data-testid="view-switch">
  {#each VIEW_KINDS as kind (kind)}
    <button
      type="button"
      role="radio"
      aria-checked={view === kind}
      class:on={view === kind}
      title={`${VIEW_LABELS[kind]} (V cycles views)`}
      onclick={() => onSelect(kind)}>{VIEW_LABELS[kind]}</button>
  {/each}
</div>

<style>
  .switch {
    position: fixed;
    left: 50%;
    bottom: var(--gutter);
    /* Sits left of the Live pill, which is centred on the same x. */
    transform: translateX(calc(-100% - 78px));
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    z-index: 2;
  }
  button {
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 999px;
    cursor: pointer;
  }
  button:hover {
    color: var(--text);
  }
  button.on {
    color: var(--text);
    background: rgba(255, 255, 255, 0.12);
  }
  @media (max-width: 720px) {
    .switch {
      bottom: calc(var(--gutter) + 36px);
      transform: translateX(-50%);
    }
  }
</style>
