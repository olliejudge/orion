<script lang="ts">
  import { onMount } from "svelte";
  import { connect, type ConnectionStatus } from "../connection";
  import { RepoStore, type RepoState } from "../store";

  const store = new RepoStore();
  let repo: RepoState | null = $state.raw(null);
  let status: ConnectionStatus = $state("connecting");

  onMount(() => {
    const off = store.subscribe((s) => (repo = s));
    const stop = connect(store, { onStatus: (s) => (status = s) });
    return () => {
      off();
      stop();
    };
  });
</script>

<main>
  <h1>{repo?.repo.name ?? "Orion"}</h1>
  <p>{status === "open" ? `${repo?.tree.size ?? 0} files` : status}</p>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #07070a;
    color: #f2f2f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  main {
    padding: 24px;
  }
  h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  p {
    margin: 0;
    opacity: 0.55;
    font-size: 12px;
  }
</style>
