<script lang="ts">
  import type { ConnectionStatus } from "../connection";

  // centerX: where the map's free area is centred (CSS px); null centres on the viewport.
  let { status, centerX = null }: { status: ConnectionStatus; centerX?: number | null } = $props();
  const text = $derived(status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…");
</script>

<div
  class="pill glass"
  class:night-reveal={status === "open"}
  style:left={centerX === null ? null : `${centerX}px`}
  data-testid="live-pill" data-status={status} role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>{text}
</div>

<style>
  .pill {
    position: fixed;
    left: 50%;
    bottom: var(--gutter);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 14px 5px 11px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-dim);
    z-index: 2;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #30d158;
    box-shadow: 0 0 8px rgba(48, 209, 88, 0.7);
  }
  [data-status="open"] {
    color: var(--text);
  }
  [data-status="open"] .dot {
    animation: breathe 2.4s ease-in-out infinite;
  }
  [data-status="connecting"] .dot {
    background: #8e8e93;
    box-shadow: none;
  }
  [data-status="reconnecting"] .dot {
    background: #ff9f0a;
    box-shadow: 0 0 8px rgba(255, 159, 10, 0.6);
  }
  @keyframes breathe {
    50% {
      opacity: 0.45;
    }
  }
</style>
