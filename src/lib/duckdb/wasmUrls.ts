// Kept in its own module so the browser-only `?url` asset imports never run under vitest.
// Both bundles ship: `eh` (WebAssembly exception handling, every current browser)
// and `mvp` as the fallback selectBundle() picks when the feature is missing.
import mvpModule from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehModule from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

/** Absolute URLs: the worker resolves relative ones against its own location, not the page's. */
function absolute(url: string): string {
  return new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/').href;
}

export const DUCKDB_BUNDLES = {
  mvp: { mainModule: absolute(mvpModule), mainWorker: absolute(mvpWorker) },
  eh: { mainModule: absolute(ehModule), mainWorker: absolute(ehWorker) },
};
