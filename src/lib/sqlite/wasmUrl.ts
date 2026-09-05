// Kept in its own module so the browser-only `?url` asset import never runs under vitest.
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

export default wasmUrl;
