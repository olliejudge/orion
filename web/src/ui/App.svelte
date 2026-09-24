<script lang="ts">
  import { onMount } from "svelte";
  import { connect } from "../connection";
  import { computeFrame } from "../layout/frame";
  import type { Circle } from "../layout/pack";
  import { clickTarget } from "../render/geometry";
  import { MapRenderer } from "../render/MapRenderer";
  import { RepoStore, type Change } from "../store";

  const MAP_PAD = 48; // keeps the repo circle clear of the floating panels

  let mapEl: HTMLDivElement;

  onMount(() => {
    const store = new RepoStore();
    const renderer = new MapRenderer(mapEl);
    let layout = new Map<string, Circle>();
    let zoomPath = "";
    let scale = 1;
    let disposed = false;
    let stop = (): void => {};
    let off = (): void => {};

    const relayout = (change: Change): void => {
      const s = store.state;
      if (!s) return;
      const f = computeFrame(s, mapEl.clientWidth, mapEl.clientHeight, scale, MAP_PAD);
      layout = f.layout;
      renderer.update(f.layout, f.visuals, change);
    };
    const onResize = (): void => relayout({ kind: "patch", merged: [] });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      zoomPath = "";
      renderer.zoomTo("");
    };

    void renderer.init().then(() => {
      if (disposed) return;
      renderer.onZoom((k) => {
        scale = k;
        relayout({ kind: "patch", merged: [] });
      });
      renderer.onClick((path) => {
        zoomPath = clickTarget(path, layout, zoomPath);
        renderer.zoomTo(zoomPath);
      });
      off = store.subscribe((_s, change) => relayout(change));
      stop = connect(store);
      window.addEventListener("resize", onResize);
      window.addEventListener("keydown", onKey);
    });

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      off();
      stop();
      renderer.destroy();
    };
  });
</script>

<div class="map" data-testid="map" bind:this={mapEl}></div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: radial-gradient(ellipse at 30% 20%, #26284a 0%, #0c0c14 55%, #07070a 100%);
    color: #f2f2f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  .map {
    position: fixed;
    inset: 0;
  }
</style>
