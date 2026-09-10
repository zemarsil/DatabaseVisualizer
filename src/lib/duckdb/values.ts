/**
 * Arrow values as the query grid wants them: JSON-safe and readable. DuckDB
 * hands results back as Arrow tables, whose cells are typed (BigInt for 64-bit
 * integers, a scaled big number for DECIMAL, epoch numbers for dates and
 * timestamps, vectors and rows for nested types). The server side does the
 * same job for the pg and mariadb drivers in server/db/values.ts.
 */
import { Type, type DataType, type RecordBatch, type Table } from 'apache-arrow';

const MAX_BYTES_SHOWN = 256;

function hex(bytes: Uint8Array): string {
  const n = Math.min(bytes.length, MAX_BYTES_SHOWN);
  let out = '';
  for (let i = 0; i < n; i++) out += bytes[i].toString(16).padStart(2, '0');
  return `\\x${out}${bytes.length > n ? '…' : ''}`;
}

function bigint(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

/** "1234" with scale 2 -> "12.34"; the digits arrive unscaled from Arrow. */
export function scaledDecimal(digits: string, scale: number): string {
  const negative = digits.startsWith('-');
  let d = negative ? digits.slice(1) : digits;
  if (scale <= 0) return (negative ? '-' : '') + d;
  d = d.padStart(scale + 1, '0');
  const whole = d.slice(0, d.length - scale);
  const frac = d.slice(d.length - scale);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** An epoch in milliseconds (possibly fractional) as ISO 8601, keeping microseconds when there are any. */
export function formatTimestamp(ms: number, withZone: boolean): string {
  if (!Number.isFinite(ms)) return String(ms);
  const whole = Math.floor(ms);
  const d = new Date(whole);
  if (Number.isNaN(d.getTime())) return String(ms);
  const micros = Math.round((ms - whole) * 1000) + d.getUTCMilliseconds() * 1000;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = micros ? `.${pad(micros, 6).replace(/0+$/, '')}` : '';
  return `${date}T${time}${frac}${withZone ? 'Z' : ''}`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A time of day given in the unit Arrow declares (0 s, 1 ms, 2 µs, 3 ns). */
export function formatTime(value: number | bigint, unit: number): string {
  const perSecond = [1, 1e3, 1e6, 1e9][unit] ?? 1e6;
  const total = typeof value === 'bigint' ? Number(value) : value;
  const seconds = Math.floor(total / perSecond);
  const fracUnits = total - seconds * perSecond;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const micros = Math.round((fracUnits / perSecond) * 1e6);
  const frac = micros ? `.${pad(micros, 6).replace(/0+$/, '')}` : '';
  return `${pad(h)}:${pad(m)}:${pad(s)}${frac}`;
}

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return bigint(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return hex(v);
  if (typeof v === 'object') {
    const o = v as { toJSON?: () => unknown; length?: number; get?: (i: number) => unknown };
    if (typeof o.get === 'function' && typeof o.length === 'number') {
      const out: unknown[] = [];
      for (let i = 0; i < o.length; i++) out.push(plain(o.get(i)));
      return out;
    }
    if (typeof o.toJSON === 'function') return plain(o.toJSON());
    if (Array.isArray(v)) return v.map(plain);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = plain(val);
    return out;
  }
  return v;
}

/**
 * One Arrow value as a plain JS value, guided by the column's declared type.
 * Nested types come back as arrays and objects; callers that want a string for
 * a grid cell stringify those (see `cellValue`).
 */
export function plainValue(v: unknown, type: DataType | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (!type) return plain(v);
  const t = type as DataType & { typeId: number; scale?: number; unit?: number; timezone?: string | null; children?: { name: string; type: DataType }[]; dictionary?: DataType };
  switch (t.typeId as Type) {
    case Type.Dictionary:
      return plainValue(v, t.dictionary);
    case Type.Decimal: {
      const digits = typeof v === 'bigint' || typeof v === 'number' ? String(v) : String(v);
      return /^-?\d+$/.test(digits) ? scaledDecimal(digits, t.scale ?? 0) : digits;
    }
    case Type.Date:
      return typeof v === 'number' ? formatDate(v) : v instanceof Date ? formatDate(v.getTime()) : plain(v);
    case Type.Timestamp:
      return typeof v === 'number' ? formatTimestamp(v, Boolean(t.timezone)) : v instanceof Date ? formatTimestamp(v.getTime(), Boolean(t.timezone)) : plain(v);
    case Type.Time:
      return typeof v === 'number' || typeof v === 'bigint' ? formatTime(v, t.unit ?? 2) : plain(v);
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
      return v instanceof Uint8Array ? hex(v) : plain(v);
    case Type.List:
    case Type.FixedSizeList: {
      const child = t.children?.[0]?.type;
      const vec = v as { length: number; get: (i: number) => unknown };
      if (typeof vec.get !== 'function') return plain(v);
      const out: unknown[] = [];
      for (let i = 0; i < vec.length; i++) out.push(plainValue(vec.get(i), child));
      return out;
    }
    case Type.Struct: {
      const row = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of t.children ?? []) out[f.name] = plainValue(row[f.name], f.type);
      return out;
    }
    case Type.Map: {
      const entry = t.children?.[0]?.type as { children?: { name: string; type: DataType }[] } | undefined;
      const valueType = entry?.children?.[1]?.type;
      const raw = typeof (v as { toJSON?: () => unknown }).toJSON === 'function' ? ((v as { toJSON: () => unknown }).toJSON() as Record<string, unknown>) : (v as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(raw)) out[k] = plainValue(val, valueType);
      return out;
    }
    case Type.Interval: {
      // Arrow JS does not decode DuckDB's month/day/nanosecond intervals
      // reliably; show the raw words rather than a wrong duration.
      const words = ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : [];
      return words.length >= 4 ? { months: words[0], days: words[1], micros: (words[2] + words[3] * 2 ** 32) / 1000 } : plain(v);
    }
    default:
      return plain(v);
  }
}

/** A grid cell: scalars stay scalars, anything nested becomes JSON text, like the server's serializeCell. */
export function cellValue(v: unknown, type: DataType | undefined): unknown {
  const p = plainValue(v, type);
  if (p !== null && typeof p === 'object') {
    try {
      return JSON.stringify(p);
    } catch {
      return String(p);
    }
  }
  return p;
}

/** Every row of a record batch as plain values (nested values kept as arrays / objects). */
export function batchRows(batch: RecordBatch, cells: 'plain' | 'cell' = 'cell'): unknown[][] {
  const fields = batch.schema.fields;
  const convert = cells === 'cell' ? cellValue : plainValue;
  const out: unknown[][] = [];
  for (let i = 0; i < batch.numRows; i++) {
    const row = batch.get(i) as Record<string, unknown> | null;
    if (!row) continue;
    out.push(fields.map((f) => convert(row[f.name], f.type)));
  }
  return out;
}

/** Every row of a whole table (used for catalog queries, which are small). */
export function tableRows(table: Table, cells: 'plain' | 'cell' = 'plain'): unknown[][] {
  const out: unknown[][] = [];
  for (const batch of table.batches) out.push(...batchRows(batch, cells));
  return out;
}

export function columnNames(table: Table | RecordBatch): string[] {
  return table.schema.fields.map((f) => f.name);
}
