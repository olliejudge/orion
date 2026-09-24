import { startOrion } from "./orion";

/** One orion on a synthetic demo repo, shared by the tests via ORION_URL / ORION_DEMO_DIR. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const orion = await startOrion();
  process.env.ORION_URL = orion.url;
  process.env.ORION_DEMO_DIR = orion.demoDir;
  return orion.stop;
}
