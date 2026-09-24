<script lang="ts">
  import { onMount } from "svelte";
  import { connect, type ConnectionStatus } from "../connection";
  import { computeFrame } from "../layout/frame";
  import { Linger } from "../layout/linger";
  import type { Circle } from "../layout/pack";
  import type { WorktreeId } from "../protocol";
  import { clickTarget } from "../render/geometry";
  import { MapRenderer } from "../render/MapRenderer";
  import { SHIMMER_MS } from "../render/scene";
  import { RepoStore, type Change, type RepoState } from "../store";
  import Activity from "./Activity.svelte";
  import { keyAction } from "./keys";
  import Legend from "./Legend.svelte";
  import LivePill from "./LivePill.svelte";
  import { mapInsets, shownFolder, tooltipInfo, type TooltipInfo } from "./models";
  import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";
  import Tooltip from "./Tooltip.svelte";

  const NO_CHANGE: Change = { kind: "patch", merged: [] };

  const store = new RepoStore();
  let repo: RepoState | null = $state.raw(null);
  let status: ConnectionStatus = $state("connecting");
  let theme: Theme = $state(loadTheme());
  let isolated: WorktreeId | null = $state(null);
  let now = $state(Date.now());
  let tip: { info: TooltipInfo; x: number; y: number } | null = $state.raw(null);
  let noWebGL = $state(false);

  let mapEl: HTMLDivElement;
  let renderer: MapRenderer | null = null;
  let layout = new Map<string, Circle>();
  let zoomPath = "";
  let scale = 1;
  // Just-merged paths stay in the layout (even if now too small to show)
  // until their shimmer ends, so a merge never reads as a deletion.
  const linger = new Linger(SHIMMER_MS);
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    applyTheme(theme);
    saveTheme(theme);
    renderer?.setTheme(theme);
    relayout(NO_CHANGE); // the map's free area depends on the theme
  });

  $effect(() => {
    // Read `isolated` unconditionally: behind `renderer?.` it would not be
    // read while the renderer is starting, and the effect would never rerun.
    const id = isolated;
    renderer?.isolate(id);
  });

  function relayout(change: Change): void {
    const s = store.state;
    if (!s || !renderer) return;
    const w = mapEl.clientWidth;
    const h = mapEl.clientHeight;
    const f = computeFrame(s, w, h, scale, mapInsets(theme, w, h), linger.paths());
    layout = f.layout;
    renderer.setFreeArea(f.free);
    renderer.update(f.layout, f.visuals, change);
  }

  function scheduleLinger(): void {
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerTimer = null;
    const next = linger.nextExpiry();
    if (next === null) return;
    lingerTimer = setTimeout(
      () => {
        lingerTimer = null;
        if (linger.expire(performance.now())) relayout(NO_CHANGE);
        scheduleLinger();
      },
      Math.max(0, next - performance.now()) + 20,
    );
  }

  function onChange(s: RepoState, change: Change): void {
    repo = s;
    // A worktree that went away can't stay isolated (everything would stay dimmed).
    if (isolated !== null && !s.worktrees.has(isolated)) isolated = null;
    if (change.merged.length > 0) {
      linger.add(change.merged, performance.now());
      scheduleLinger();
    }
    relayout(change);
  }

  function zoom(path: string): void {
    zoomPath = path;
    renderer?.zoomTo(path);
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function onKey(e: KeyboardEvent): void {
    const action = keyAction(e);
    if (action === "theme") theme = theme === "vision" ? "night" : "vision";
    else if (action === "zoomOut") {
      // Esc backs out one step: first the isolation, then the zoom.
      if (isolated !== null) isolated = null;
      else zoom("");
    }
    else if (action === "fullscreen") toggleFullscreen();
  }

  onMount(() => {
    const r = new MapRenderer(mapEl);
    let disposed = false;
    const off = store.subscribe(onChange);
    const tick = setInterval(() => (now = Date.now()), 5000);
    const onResize = (): void => relayout(NO_CHANGE);
    let stop = (): void => {};
    const start = (): void => {
      if (!disposed) stop = connect(store, { onStatus: (s) => (status = s) });
    };

    r.init().then(
      () => {
        if (disposed) return;
        renderer = r;
        r.setTheme(theme);
        r.isolate(isolated);
        r.onZoom((k) => {
          scale = k;
          relayout(NO_CHANGE);
        });
        r.onClick((path) => zoom(clickTarget(path, layout, zoomPath)));
        r.onHover((path, at) => {
          const c = path === null ? undefined : layout.get(path);
          const info = c && repo ? tooltipInfo(repo, c) : null;
          tip = info ? { info, x: at.x, y: at.y } : null;
        });
        relayout({ kind: "snapshot", merged: [] });
        start();
      },
      (err: unknown) => {
        // Pixi found no usable WebGL, WebGPU or canvas context (or failed to
        // start one): say so instead of leaving a blank page. The panels still work.
        console.error("Orion: could not start the map renderer", err);
        noWebGL = true;
        start();
      },
    );
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      clearInterval(tick);
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      window.removeEventListener("resize", onResize);
      off();
      stop();
      r.destroy();
      renderer = null;
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="map" data-testid="map" bind:this={mapEl}></div>

{#if noWebGL}
  <div class="fallback glass" role="alert">
    <h1>Can’t draw the map</h1>
    <p>This browser couldn’t start WebGL or a drawing canvas. Turn on hardware acceleration, or open this page in another browser.</p>
  </div>
{/if}

{#if repo}
  <Legend {repo} {now} {isolated} onIsolate={(id) => (isolated = id)} />
  <Activity {repo} {now} onHover={(p) => renderer?.highlight(p)} onSelect={(p) => zoom(shownFolder(p, layout))} />
{/if}
<LivePill {status} />
<Tooltip info={tip?.info ?? null} x={tip?.x ?? 0} y={tip?.y ?? 0} />

<style>
  .map {
    position: fixed;
    inset: 0;
  }
  .fallback {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    width: min(360px, calc(100vw - 2 * var(--gutter)));
    padding: 18px 20px;
    text-align: center;
    z-index: 1;
  }
  .fallback h1 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .fallback p {
    margin: 0;
    color: var(--text-dim);
    font-size: 12.5px;
  }
</style>
