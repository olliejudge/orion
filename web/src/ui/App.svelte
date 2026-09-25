<script lang="ts">
  import { onMount } from "svelte";
  import { servedBuildChanged } from "../build";
  import { connect, repoIdentity, type ConnectionStatus } from "../connection";
  import { directoryEntries, isExcluded, loadExcluded, nearestVisibleAncestor, saveExcluded } from "../layout/exclude";
  import { computeFrame } from "../layout/frame";
  import { Linger } from "../layout/linger";
  import { buildTree } from "../layout/nodes";
  import type { Circle } from "../layout/pack";
  import { nearestShown } from "../layout/shown";
  import type { Snapshot, WorktreeId } from "../protocol";
  import { labelNames } from "../render/geometry";
  import { MapRenderer } from "../render/MapRenderer";
  import { SHIMMER_MS } from "../render/scene";
  import { RepoStore, type Change, type RepoState } from "../store";
  import Activity from "./Activity.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import { FrameCoalescer } from "./coalesce";
  import DirFilter from "./DirFilter.svelte";
  import { keyAction } from "./keys";
  import Legend from "./Legend.svelte";
  import LivePill from "./LivePill.svelte";
  import MapKey from "./MapKey.svelte";
  import {
    crumbsSlot,
    dirFilterTreeMaxHeight,
    hoverTip,
    mapInsets,
    shownFolder,
    stackFootprint,
    type CrumbsSize,
    type Footprint,
    type HoverTarget,
    type TooltipInfo,
  } from "./models";
  import { clickTarget, crumbs, doubleClickTarget, stepIn, upOne } from "./nav";
  import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";
  import Tooltip from "./Tooltip.svelte";

  const DIRFILTER_GAP = 8; // gap between the map key and the filter panel stacked above it

  const NO_CHANGE: Change = { kind: "patch", merged: [] };

  const store = new RepoStore();
  let repo: RepoState | null = $state.raw(null);
  let status: ConnectionStatus = $state("connecting");
  let theme: Theme = $state(loadTheme());
  let isolated: WorktreeId | null = $state(null);
  let now = $state(Date.now());
  let tip: { info: TooltipInfo; x: number; y: number } | null = $state.raw(null);
  let noWebGL = $state(false);
  let legendBox: Footprint = $state.raw({ width: 0, height: 0 });
  let keyBox: Footprint = $state.raw({ width: 0, height: 0 });
  let dirFilterBox: Footprint = $state.raw({ width: 0, height: 0 });
  let pillX: number | null = $state(null); // centre of the map's free area
  let viewW = $state(0);
  let viewH = $state(0);
  let crumbsBox: CrumbsSize = $state.raw({ full: 0, min: 0 });
  // The breadcrumbs keep clear of the legend (and Vision's activity panel).
  const crumbsAt = $derived(viewW > 0 ? crumbsSlot(theme, viewW, legendBox, pillX, crumbsBox) : null);
  // The map key and the folder filter both live bottom-left, stacked: mapInsets
  // (and the filter's own position) treat them as one combined obstacle.
  const bottomLeftBox = $derived(stackFootprint(keyBox, dirFilterBox, DIRFILTER_GAP));
  const dirFilterLift = $derived(keyBox.height > 0 ? keyBox.height + DIRFILTER_GAP : 0);
  // Caps the open filter's scrolling tree so it can never grow into the
  // legend above it, however tall the legend gets (more worktrees), however
  // the window is sized, and whichever way the map key (above `dirFilterLift`
  // folds in) is toggled.
  const dirFilterTreeMax = $derived(viewH > 0 ? dirFilterTreeMaxHeight(viewH, legendBox, dirFilterLift) : undefined);

  // Directories hidden from the map, persisted per repo (see layout/exclude.ts).
  let excluded: ReadonlySet<string> = $state.raw(new Set());
  let excludedFor: string | null = null; // the repo name `excluded` was loaded for
  const dirs = $derived(repo ? directoryEntries(buildTree(repo)) : []);

  function setExcluded(next: Set<string>): void {
    excluded = next;
    if (repo) saveExcluded(repo.repo.name, next);
  }

  let mapEl: HTMLDivElement;
  let renderer: MapRenderer | null = null;
  let layout: Map<string, Circle> = $state.raw(new Map());
  // Folder names as the map shows them: the navigation levels (see nav.ts).
  let labels: Map<string, string> = $state.raw(new Map());
  let zoomPath = $state(""); // the folder in view: the last zoom target, or the focus after free zoom/pan
  let beforeClick = ""; // the folder in view before a double click's first click
  let scale = 1;
  let hovered: string | null = null; // the activity row's path under the pointer
  let mapHover: HoverTarget | null = null; // the map's path under the pointer (drives the tooltip)
  // Relayouts (patches, resizes, theme and linger changes) run at most once per frame.
  const queue = new FrameCoalescer((c) => {
    try {
      relayout(c);
    } catch (err) {
      console.error("Orion: could not update the map", err);
    }
  });
  // Just-merged paths stay in the layout (even if now too small to show)
  // until their shimmer ends, so a merge never reads as a deletion.
  const linger = new Linger(SHIMMER_MS);
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    applyTheme(theme);
    saveTheme(theme);
    renderer?.setTheme(theme);
    queue.request(NO_CHANGE); // the map's free area depends on the theme
  });

  $effect(() => {
    void legendBox; // the map keeps clear of the legend and the key/filter stack (see mapInsets)
    void bottomLeftBox;
    queue.request(NO_CHANGE);
  });

  $effect(() => {
    void excluded; // toggling a folder re-lays out the map like any other node-set change
    queue.request(NO_CHANGE);
  });

  $effect(() => {
    // Read `isolated` unconditionally: behind `renderer?.` it would not be
    // read while the renderer is starting, and the effect would never rerun.
    const id = isolated;
    renderer?.isolate(id);
  });

  $effect(() => {
    // A repo loads its own remembered exclusions once its name is known (a
    // reconnect that lands on a different repo reloads the page first, see
    // App's onSnapshot below, so `repo.repo.name` is stable for the rest of
    // this page's life).
    const name = repo?.repo.name;
    if (name !== undefined && name !== excludedFor) {
      excludedFor = name;
      excluded = loadExcluded(name);
    }
  });

  $effect(() => {
    // If the zoom focus just became (or already was, on load) excluded, back
    // out to the nearest ancestor still on the map.
    const ex = excluded;
    if (isExcluded(zoomPath, ex)) zoom(nearestVisibleAncestor(zoomPath, ex));
  });

  function relayout(change: Change): void {
    const s = store.state;
    if (!s || !renderer) return;
    const w = mapEl.clientWidth;
    const h = mapEl.clientHeight;
    if (w <= 0 || h <= 0) return; // nothing to lay out into (d3's pack throws on an empty rect)
    const f = computeFrame(s, w, h, scale, mapInsets(theme, w, h, legendBox, bottomLeftBox), linger.paths(), excluded);
    layout = f.layout;
    labels = labelNames(f.layout);
    pillX = (f.free.x0 + f.free.x1) / 2;
    renderer.setFreeArea(f.free);
    renderer.update(f.layout, f.visuals, change);
    highlight(hovered); // what stands in for the hovered path may have changed
    tip = hoverTip(s, layout, mapHover, zoomPath); // the file under a still pointer may have changed
  }

  // A file inside a collapsed folder is highlighted as the folder's aggregate.
  function highlight(path: string | null): void {
    hovered = path;
    renderer?.highlight(path === null ? null : nearestShown(path, layout));
  }

  function scheduleLinger(): void {
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    lingerTimer = null;
    const next = linger.nextExpiry();
    if (next === null) return;
    lingerTimer = setTimeout(
      () => {
        lingerTimer = null;
        if (linger.expire(performance.now())) queue.request(NO_CHANGE);
        scheduleLinger();
      },
      Math.max(0, next - performance.now()) + 20,
    );
  }

  function onChange(s: RepoState, change: Change): void {
    // A throw here would unwind into the socket handler and freeze the map.
    try {
      repo = s;
      // A worktree that went away can't stay isolated (everything would stay dimmed).
      if (isolated !== null && !s.worktrees.has(isolated)) isolated = null;
      if (change.merged.length > 0) {
        linger.add(change.merged, performance.now());
        scheduleLinger();
      }
      queue.request(change);
    } catch (err) {
      console.error("Orion: could not apply an update", err);
    }
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
      else zoom(upOne(zoomPath, layout, labels));
    }
    else if (action === "fullscreen") toggleFullscreen();
    // + / = steps in toward the folder under the pointer, or the largest
    // child of the folder in view when the pointer isn't over the map.
    else if (action === "zoomIn") zoom(stepIn(mapHover?.path ?? null, layout, labels, zoomPath));
    else if (action === "home") zoom("");
  }

  onMount(() => {
    const r = new MapRenderer(mapEl);
    let disposed = false;
    const off = store.subscribe(onChange);
    const tick = setInterval(() => (now = Date.now()), 5000);
    const onResize = (): void => queue.request(NO_CHANGE);
    let stop = (): void => {};
    // The repo this page has shown since it loaded, so a reconnect that
    // lands on a different repo (orion restarted serving a different repo
    // on this port) can be told apart from one that lands back on the same
    // repo. Set from the first snapshot of this page load; never reloads on it.
    let shownRepo: string | null = null;
    const start = (): void => {
      if (!disposed)
        stop = connect(store, {
          onStatus: (s) => (status = s),
          // Orion may have restarted on a newer build; if the served bundle
          // changed, reload so we pick up the new UI instead of running stale JS.
          onReconnect: () => {
            void servedBuildChanged(document).then((changed) => {
              if (changed) location.reload();
            });
          },
          // A restarted orion may now be serving a different repo on this
          // port. One token now covers every orion instance, so this tab
          // would otherwise silently switch repos with stale navigation
          // state. Reload before the snapshot is applied, so the page
          // starts clean instead of flashing the other repo's map.
          onSnapshot: (s: Snapshot) => {
            const id = repoIdentity(s);
            if (shownRepo === null) shownRepo = id;
            else if (id !== shownRepo) location.reload();
          },
        });
    };

    r.init().then(
      () => {
        if (disposed) return;
        renderer = r;
        r.setTheme(theme);
        r.isolate(isolated);
        r.onZoom((k) => {
          scale = k;
          // Culling follows the camera without a frame's lag.
          queue.request(NO_CHANGE);
          queue.flush();
        });
        r.onClick((path) => {
          beforeClick = zoomPath;
          zoom(clickTarget(path, layout, labels, zoomPath));
        });
        r.onDoubleClick((path) => zoom(doubleClickTarget(path, layout, labels, beforeClick)));
        r.onFocus((path) => (zoomPath = path));
        r.onHover((path, at) => {
          mapHover = path === null ? null : { path, at };
          tip = hoverTip(repo, layout, mapHover, zoomPath);
        });
        queue.request({ kind: "snapshot", merged: [] });
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
      queue.cancel();
      window.removeEventListener("resize", onResize);
      off();
      stop();
      r.destroy();
      renderer = null;
    };
  });
</script>

<svelte:window onkeydown={onKey} bind:innerWidth={viewW} bind:innerHeight={viewH} />

<div class="map" data-testid="map" role="img" aria-label="Repository map" bind:this={mapEl}></div>

{#if noWebGL}
  <div class="fallback glass" role="alert">
    <h1>Can’t draw the map</h1>
    <p>This browser couldn’t start WebGL or a drawing canvas. Turn on hardware acceleration, or open this page in another browser.</p>
  </div>
{/if}

{#if repo}
  <Legend
    {repo}
    {now}
    {isolated}
    {excluded}
    onIsolate={(id) => (isolated = id)}
    onFootprint={(b) => (legendBox = b)}
    reserveBottom={Math.max(64, bottomLeftBox.height + 32)} />
  <Activity {repo} {now} {excluded} onHover={highlight} onSelect={(p) => zoom(shownFolder(p, layout))} />
{/if}
{#if repo && !noWebGL}
  <DirFilter
    {dirs}
    {excluded}
    onChange={setExcluded}
    onFootprint={(b) => (dirFilterBox = b)}
    lift={dirFilterLift}
    treeMaxHeight={dirFilterTreeMax} />
{/if}
{#if !noWebGL}
  <MapKey {theme} onFootprint={(b) => (keyBox = b)} />
{/if}
<LivePill {status} centerX={pillX} />
{#if repo}
  <Breadcrumbs
    crumbs={crumbs(zoomPath, layout, labels, repo.repo.name)}
    slot={crumbsAt}
    onMeasure={(b) => (crumbsBox = b)}
    onSelect={zoom} />
{/if}
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
