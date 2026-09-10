import { engineName, type Column, type Diagram, type Table } from '@shared/types';
import { externalTableIds } from './groups';
import { customTypeByName } from './model';
import { isIntegerType, normalizeType, quoteIdent, quoteQualified, quoteString } from './sql/dialect';
import { orderTables, sequenceDefault } from './sql/generator';

/**
 * Deterministic sample data. The same diagram and seed always produce the same
 * INSERT script, so a seed file can live next to the schema and be re-run.
 *
 * Values respect what the schema says: foreign keys point at rows generated for
 * the parent table, unique columns never repeat, enums and simple CHECK (col IN
 * (...)) constraints pick from their list, NOT NULL is never NULL, and column
 * names steer the content (email, first_name, price, created_at, ...).
 */

export interface SeedOptions {
  /** Rows per table (default 10). */
  rows?: number;
  /** Per-table overrides by table id. */
  perTable?: Record<string, number>;
  /** PRNG seed (default 1). */
  seed?: number;
  /** Chance that a nullable, non-key column is NULL (default 0.1). */
  nullRate?: number;
  /** Rows per INSERT statement (default 50). */
  batchSize?: number;
  /**
   * Values a column should sometimes take, by column id. The simulator passes
   * the literals a data flow filters on (status = 'paid'), so the generated
   * rows contain something for the filter to match. A hint that an enum or
   * CHECK list does not allow is ignored.
   */
  valueHints?: Record<string, RawValue[]>;
  /**
   * Also generate rows for tables in external groups. The seed script never
   * inserts into another database, but a simulation needs those tables to have
   * rows, because they are where the data comes from.
   */
  includeExternal?: boolean;
}

export interface SeedResult {
  statements: string[];
  script: string;
  warnings: string[];
  rowCounts: Record<string, number>;
  totalRows: number;
}

/* ---------------- PRNG ---------------- */

/** mulberry32: tiny, fast, and good enough for sample data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += this.int(0, 15).toString(16);
    return s;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

/* ---------------- Vocabulary ---------------- */

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Frances', 'Donald', 'Hedy', 'Edsger', 'Anita', 'Guido', 'Yukihiro', 'Brendan', 'Sophie', 'Niklaus', 'Leslie', 'Bjarne', 'Mary', 'John', 'Katherine', 'James'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners-Lee', 'Allen', 'Knuth', 'Lamarr', 'Dijkstra', 'Borg', 'van Rossum', 'Matsumoto', 'Eich', 'Wilson', 'Wirth', 'Lamport', 'Stroustrup', 'Shaw', 'Backus', 'Johnson', 'Gosling'];
const NOUNS = ['lantern', 'harbor', 'meadow', 'compass', 'ledger', 'orchard', 'summit', 'canvas', 'beacon', 'ember', 'quarry', 'ripple', 'saddle', 'thicket', 'anchor', 'breeze', 'cobble', 'drift', 'fable', 'glacier', 'hollow', 'isle', 'juniper', 'kettle', 'marble', 'nectar'];
const ADJ = ['quiet', 'bright', 'amber', 'swift', 'gentle', 'bold', 'crimson', 'silver', 'rustic', 'vivid', 'mellow', 'sturdy', 'brisk', 'hazel', 'ivory', 'lucid', 'nimble', 'plain', 'sleek', 'tidy'];
const WORDS = ['the', 'and', 'with', 'from', 'about', 'over', 'under', 'again', 'still', 'rather', 'quite', 'nearly', 'morning', 'river', 'window', 'letter', 'garden', 'market', 'silver', 'shadow', 'bridge', 'season', 'journey', 'circle', 'signal', 'pattern', 'notice', 'reason', 'record', 'simple', 'steady', 'careful', 'sudden', 'narrow', 'ancient', 'modern', 'nearby', 'hidden', 'open', 'golden'];
const CITIES = ['Lisbon', 'Oslo', 'Kyoto', 'Montreal', 'Nairobi', 'Porto', 'Tallinn', 'Valparaiso', 'Wellington', 'Zagreb', 'Bergen', 'Cork', 'Denver', 'Edinburgh', 'Fukuoka', 'Ghent', 'Hobart', 'Izmir', 'Jaipur', 'Kaunas'];
const COUNTRIES = ['Portugal', 'Norway', 'Japan', 'Canada', 'Kenya', 'Estonia', 'Chile', 'New Zealand', 'Croatia', 'Ireland', 'United States', 'United Kingdom', 'Belgium', 'Australia', 'Turkey', 'India', 'Lithuania', 'Germany', 'Brazil', 'Spain'];
const STATES = ['Alabama', 'Oregon', 'Vermont', 'Bavaria', 'Ontario', 'Queensland', 'Catalonia', 'Hokkaido', 'Tuscany', 'Wales'];
const STREETS = ['Harbor Road', 'Maple Street', 'Station Lane', 'Mill Avenue', 'Orchard Way', 'Quay Street', 'Ridge Drive', 'Elm Court', 'Bridge Street', 'Park Row'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example', 'test.example'];
const STATUSES = ['pending', 'active', 'completed', 'cancelled', 'archived'];
const ROLES = ['admin', 'editor', 'member', 'viewer', 'guest'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
const LANGUAGES = ['en', 'de', 'fr', 'es', 'pt', 'ja'];
const COLORS = ['red', 'green', 'blue', 'amber', 'teal', 'violet', 'coral', 'slate'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const GENDERS = ['female', 'male', 'non-binary', 'other'];
const KINDS = ['standard', 'premium', 'basic', 'trial', 'internal'];
const FILE_EXT = ['png', 'jpg', 'pdf', 'txt', 'csv'];

const PERSON_TABLES = /(user|people|person|customer|employee|author|member|staff|contact|account|student|teacher|patient|client|supplier|vendor|owner|player|profile)/;

/* ---------------- Types ---------------- */

export type RawValue = null | boolean | number | string | { hex: string } | { expr: string };

export interface TypeInfo {
  base: string;
  args: number[];
  unsigned: boolean;
  array: boolean;
  enumValues: string[] | null;
}

function typeInfo(d: Diagram, type: string): TypeInfo {
  const ct = customTypeByName(d, type);
  if (ct?.kind === 'enum') return { base: 'ENUM', args: [], unsigned: false, array: false, enumValues: (ct.values ?? []).filter((v) => v.trim()) };
  if (ct?.kind === 'composite') return { base: 'JSON', args: [], unsigned: false, array: false, enumValues: null };
  const norm = normalizeType(type);
  const array = /\[\]$/.test(norm);
  const m = /^([A-Z0-9_ ]+?)(?:\((.*?)\))?(?:\s*\[\])*(?:\s+(UNSIGNED|ZEROFILL|UNSIGNED ZEROFILL|WITH TIME ZONE|WITHOUT TIME ZONE))?$/.exec(norm);
  const base = (m?.[1] ?? norm).trim();
  const argText = m?.[2] ?? '';
  const unsigned = /UNSIGNED/.test(m?.[3] ?? '');
  if (base === 'ENUM' || base === 'SET') {
    const values = [...argText.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    return { base, args: [], unsigned, array, enumValues: values };
  }
  const args = argText
    .split(',')
    .map((a) => Number(a.trim()))
    .filter((n) => Number.isFinite(n));
  return { base, args, unsigned, array, enumValues: null };
}

const INT_MAX: Record<string, number> = { TINYINT: 127, SMALLINT: 32767, INT2: 32767, SMALLSERIAL: 32767, MEDIUMINT: 8388607, YEAR: 2155 };

/* ---------------- Constraints read from CHECK bodies ---------------- */

interface Range {
  min?: number;
  max?: number;
  oneOf?: string[];
}

function rangeFromChecks(col: Column, t: Table): Range {
  const r: Range = {};
  const name = col.name.toLowerCase();
  const bodies = [col.check ?? '', ...t.checks].filter((b) => b.trim());
  const ident = `(?:"${name}"|\`${name}\`|\\b${name}\\b)`;
  for (const body of bodies) {
    const b = body.trim();
    const inList = new RegExp(`${ident}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(b);
    if (inList) r.oneOf = [...inList[1].matchAll(/'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g)].map((m) => m[1] ?? m[2]).filter((v): v is string => v !== undefined);
    const between = new RegExp(`${ident}\\s+BETWEEN\\s+(-?\\d+(?:\\.\\d+)?)\\s+AND\\s+(-?\\d+(?:\\.\\d+)?)`, 'i').exec(b);
    if (between) {
      r.min = Number(between[1]);
      r.max = Number(between[2]);
    }
    for (const m of b.matchAll(new RegExp(`${ident}\\s*(>=|>|<=|<)\\s*(-?\\d+(?:\\.\\d+)?)`, 'gi'))) {
      const n = Number(m[2]);
      if (m[1] === '>=') r.min = n;
      else if (m[1] === '>') r.min = n + 1;
      else if (m[1] === '<=') r.max = n;
      else r.max = n - 1;
    }
    for (const m of b.matchAll(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(>=|>|<=|<)\\s*${ident}`, 'gi'))) {
      const n = Number(m[1]);
      if (m[2] === '<=') r.min = n;
      else if (m[2] === '<') r.min = n + 1;
      else if (m[2] === '>=') r.max = n;
      else r.max = n - 1;
    }
  }
  return r;
}

/* ---------------- Value generation ---------------- */

const BASE_TIME = Date.UTC(2025, 0, 1, 9, 0, 0);

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function fmtTime(ms: number): string {
  const dt = new Date(ms);
  return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

function fmtTimestamp(ms: number): string {
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}

function sentence(rng: Rng, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(rng.pick(WORDS));
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function clampText(s: string, info: TypeInfo): string {
  const max = (info.base === 'VARCHAR' || info.base === 'CHAR' || info.base === 'CHARACTER VARYING' || info.base === 'CHARACTER' || info.base === 'NVARCHAR' || info.base === 'NCHAR') && info.args[0] ? info.args[0] : Infinity;
  return s.length > max ? s.slice(0, max) : s;
}

interface GenCtx {
  d: Diagram;
  rng: Rng;
  warnings: Set<string>;
}

/** A value steered by the column name, or null when the name says nothing. */
function byName(ctx: GenCtx, t: Table, col: Column, info: TypeInfo, i: number, unique: boolean): RawValue | undefined {
  const { rng } = ctx;
  const n = col.name.toLowerCase();
  const tname = t.name.toLowerCase();
  const textual = /^(TEXT|VARCHAR|CHAR|CHARACTER VARYING|CHARACTER|NVARCHAR|NCHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|CITEXT|CLOB|STRING)$/.test(info.base);
  const numeric = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|NUMERIC|DECIMAL|DEC|REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|MONEY)$/.test(info.base);
  const integer = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL)$/.test(info.base);
  const temporal = /^(DATE|TIME|TIMETZ|TIMESTAMP|TIMESTAMPTZ|DATETIME)$/.test(info.base);
  const person = PERSON_TABLES.test(tname);
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  const suffix = unique ? String(i + 1) : '';

  if (textual) {
    if (/(^|_)e?mail$/.test(n) || /email/.test(n)) return `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}${suffix}@${rng.pick(DOMAINS)}`;
    if (/^(first_?name|given_?name|forename)$/.test(n)) return unique ? `${first}${suffix}` : first;
    if (/^(last_?name|surname|family_?name)$/.test(n)) return unique ? `${last}${suffix}` : last;
    if (/^(user_?name|login|handle|nick(name)?|screen_?name)$/.test(n)) return `${first.toLowerCase()}${rng.int(10, 99)}${suffix}`;
    if (/^(full_?name|display_?name|name|contact_?name|author_?name|owner_?name)$/.test(n) && person) return `${first} ${last}${suffix ? ` ${suffix}` : ''}`;
    if (/^(name|label|title|subject|headline|caption)$/.test(n) || /_name$|_title$/.test(n)) return titleCase(`${rng.pick(ADJ)} ${rng.pick(NOUNS)}`) + (suffix ? ` ${suffix}` : '');
    if (/^(description|summary|notes?|comments?|body|content|bio|message|text|details?|remarks?|abstract)$/.test(n)) return sentence(rng, rng.int(6, 14));
    if (/(phone|mobile|tel|fax)/.test(n)) return `+1-555-${pad(rng.int(0, 99))}${pad(rng.int(0, 99))}-${String(unique ? 1000 + i : rng.int(1000, 9999))}`;
    if (/(street|address_?line|address$|^address)/.test(n)) return `${rng.int(1, 999)} ${rng.pick(STREETS)}`;
    if (/^(city|town)$/.test(n)) return rng.pick(CITIES);
    if (/^(country|nation)(_?name|_?code)?$/.test(n)) return info.args[0] && info.args[0] <= 3 ? rng.pick(['PT', 'NO', 'JP', 'CA', 'KE', 'DE', 'US', 'GB']) : rng.pick(COUNTRIES);
    if (/^(state|province|region|county)$/.test(n)) return rng.pick(STATES);
    if (/(zip|postal|post_?code)/.test(n)) return String(rng.int(10000, 99999));
    if (/(url|website|link|homepage|href)/.test(n)) return `https://${rng.pick(DOMAINS)}/${slugify(`${rng.pick(ADJ)} ${rng.pick(NOUNS)}`)}${suffix}`;
    if (/^(slug|permalink)$/.test(n)) return slugify(`${rng.pick(ADJ)} ${rng.pick(NOUNS)}${suffix ? ` ${suffix}` : ''}`);
    if (/(uuid|guid)/.test(n)) return rng.uuid();
    if (/(password|passwd|secret|token|api_?key|hash|digest|salt)/.test(n)) return rng.hex(unique ? 40 : 32) + suffix;
    if (/(image|avatar|photo|picture|thumbnail|logo|icon|file|path|filename|attachment)/.test(n)) return `/uploads/${slugify(`${rng.pick(NOUNS)}`)}${suffix}.${rng.pick(FILE_EXT)}`;
    if (/^(status|state)$/.test(n)) return rng.pick(STATUSES);
    if (/^role$/.test(n)) return rng.pick(ROLES);
    if (/currency/.test(n)) return rng.pick(CURRENCIES);
    if (/^(lang|language|locale)(_?code)?$/.test(n)) return rng.pick(LANGUAGES);
    if (/colou?r/.test(n)) return rng.pick(COLORS);
    if (/priority|severity/.test(n)) return rng.pick(PRIORITIES);
    if (/^(gender|sex)$/.test(n)) return rng.pick(GENDERS);
    if (/^(type|kind|category|tier|plan|level|group)$/.test(n) || /_type$|_kind$|_category$/.test(n)) return rng.pick(KINDS);
    if (/(^|_)(code|sku|ref|reference|number|no|serial|isbn|iban|vat|barcode|tracking)(_?number|_?code)?$/.test(n)) return `${rng.pick(['AB', 'CD', 'EF', 'GH'])}-${String(1000 + (unique ? i : rng.int(0, 8999)))}`;
    if (/(^|_)ip(_?address|v4|v6)?$/.test(n)) return `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
    if (/version/.test(n)) return `${rng.int(0, 3)}.${rng.int(0, 9)}.${rng.int(0, 20)}`;
    if (/(timezone|tz)$/.test(n)) return rng.pick(['UTC', 'Europe/Lisbon', 'Asia/Tokyo', 'America/New_York']);
    return undefined;
  }
  if (numeric) {
    if (/(price|amount|total|cost|fee|salary|balance|subtotal|tax|discount|revenue|budget|wage|rate$)/.test(n)) return integer ? rng.int(100, 99999) : Number((rng.int(100, 99999) / 100).toFixed(2));
    if (/(quantity|qty|count|stock|units|items|seats|capacity)/.test(n)) return rng.int(1, 100);
    if (/^age$/.test(n)) return rng.int(18, 80);
    if (/year/.test(n)) return rng.int(1990, 2025);
    if (/(rating|stars)/.test(n)) return integer ? rng.int(1, 5) : Number((1 + rng.float() * 4).toFixed(1));
    if (/(score|percent|pct|progress)/.test(n)) return integer ? rng.int(0, 100) : Number((rng.float() * 100).toFixed(2));
    if (/^(lat|latitude)$/.test(n)) return Number((rng.float() * 180 - 90).toFixed(6));
    if (/^(lng|lon|long|longitude)$/.test(n)) return Number((rng.float() * 360 - 180).toFixed(6));
    if (/(duration|seconds|minutes|hours|days|timeout|ttl|delay)/.test(n)) return rng.int(1, 3600);
    if (/(width|height|length|depth|size|weight|distance)/.test(n)) return integer ? rng.int(1, 500) : Number((rng.float() * 500).toFixed(2));
    if (/(position|sort|order|rank|sequence|priority|level|index)/.test(n)) return unique ? i + 1 : rng.int(1, 50);
    return undefined;
  }
  if (temporal) {
    if (/(created|inserted|registered|joined|signed_?up|opened)/.test(n)) return BASE_TIME - rng.int(1, 730) * 86_400_000 - rng.int(0, 86_399) * 1000;
    if (/(updated|modified|changed|edited|last_?seen|last_?login)/.test(n)) return BASE_TIME - rng.int(0, 60) * 86_400_000 - rng.int(0, 86_399) * 1000;
    if (/(deleted|removed|archived|cancel)/.test(n)) return null;
    if (/(birth|dob|born)/.test(n)) return Date.UTC(rng.int(1950, 2005), rng.int(0, 11), rng.int(1, 28));
    if (/(expire|expiry|due|deadline|end|until|valid_to|scheduled)/.test(n)) return BASE_TIME + rng.int(1, 365) * 86_400_000;
    if (/(start|begin|from|valid_from|published|shipped|paid|completed|sent)/.test(n)) return BASE_TIME - rng.int(0, 365) * 86_400_000;
    return undefined;
  }
  return undefined;
}

function boolByName(n: string): boolean {
  return /^(is_|has_|can_|should_|allow_|enable)/.test(n) || /(active|enabled|verified|deleted|published|visible|archived|approved|confirmed|locked|flag|default|primary|public|featured|paid|done|completed)$/.test(n);
}

/** A value steered by the column's SQL type. */
function byType(ctx: GenCtx, col: Column, info: TypeInfo, i: number, unique: boolean, range: Range): RawValue {
  const { rng } = ctx;
  const b = info.base;
  if (range.oneOf?.length) return rng.pick(range.oneOf);
  if (info.enumValues?.length) return rng.pick(info.enumValues);
  if (info.array) {
    const inner = /^(INT|INTEGER|BIGINT|SMALLINT|NUMERIC|REAL)/.test(b) ? [rng.int(1, 9), rng.int(10, 99)].join(',') : [rng.pick(NOUNS), rng.pick(NOUNS)].join(',');
    return `{${inner}}`;
  }
  if (/^(BOOL|BOOLEAN)$/.test(b) || (b === 'TINYINT' && info.args[0] === 1) || (b === 'BIT' && (info.args[0] ?? 1) === 1)) return boolByName(col.name.toLowerCase()) ? rng.chance(0.7) : rng.chance(0.5);
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|YEAR|OID)$/.test(b)) {
    if (unique) return i + 1;
    const hi = Math.min(INT_MAX[b] ?? 1000, range.max ?? 1000);
    const lo = Math.max(range.min ?? (info.unsigned ? 0 : 0), b === 'YEAR' ? 1990 : 0);
    return rng.int(lo, Math.max(lo, hi));
  }
  if (/^(NUMERIC|DECIMAL|DEC|FIXED|MONEY)$/.test(b)) {
    const [p, s] = [info.args[0] ?? 10, info.args[1] ?? 2];
    const maxWhole = Math.min(Math.pow(10, Math.max(1, Math.min(6, p - s))) - 1, range.max ?? 9999);
    const v = Math.max(range.min ?? 0, rng.float() * maxWhole);
    return Number(v.toFixed(Math.min(s, 4)));
  }
  if (/^(REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION)$/.test(b)) {
    const lo = range.min ?? 0;
    const hi = range.max ?? 1000;
    return Number((lo + rng.float() * (hi - lo)).toFixed(3));
  }
  if (/^(UUID|UNIQUEIDENTIFIER)$/.test(b)) return rng.uuid();
  if (b === 'DATE') return fmtDate(BASE_TIME - rng.int(0, 730) * 86_400_000);
  if (/^(TIME|TIMETZ)$/.test(b)) return fmtTime(BASE_TIME + rng.int(0, 86_399) * 1000);
  if (/^(TIMESTAMP|TIMESTAMPTZ|DATETIME)$/.test(b)) return fmtTimestamp(BASE_TIME - rng.int(0, 730) * 86_400_000 - rng.int(0, 86_399) * 1000);
  if (b === 'INTERVAL') return `${rng.int(1, 30)} days`;
  if (/^(JSON|JSONB)$/.test(b)) return JSON.stringify({ key: rng.pick(NOUNS), n: rng.int(1, 99), ok: rng.chance(0.5) });
  if (/^(BYTEA|BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BINARY|VARBINARY)$/.test(b)) return { hex: rng.hex(Math.min(16, (info.args[0] ?? 8) * 2)) };
  if (/^(INET|INET4|INET6|CIDR)$/.test(b)) return b === 'CIDR' ? `10.${rng.int(0, 255)}.0.0/16` : `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`;
  if (b === 'MACADDR') return `02:${rng.hex(2)}:${rng.hex(2)}:${rng.hex(2)}:${rng.hex(2)}:${rng.hex(2)}`;
  if (b === 'POINT') return `(${(rng.float() * 100).toFixed(2)},${(rng.float() * 100).toFixed(2)})`;
  if (/^(XML)$/.test(b)) return `<item id="${i + 1}"/>`;
  if (/^(CHAR|CHARACTER|NCHAR)$/.test(b) && (info.args[0] ?? 1) <= 3) {
    let s = '';
    for (let k = 0; k < (info.args[0] ?? 1); k++) s += String.fromCharCode(65 + rng.int(0, 25));
    return s;
  }
  if (/^(TEXT|VARCHAR|CHAR|CHARACTER VARYING|CHARACTER|NVARCHAR|NCHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|CITEXT|CLOB|STRING)$/.test(b)) {
    const len = info.args[0] ?? 255;
    const s = len <= 12 ? rng.pick(NOUNS) : len <= 40 ? titleCase(`${rng.pick(ADJ)} ${rng.pick(NOUNS)}`) : sentence(rng, rng.int(4, 9));
    return clampText(unique ? `${s} ${i + 1}` : s, info);
  }
  if (/^(GEOMETRY|GEOGRAPHY|LINESTRING|POLYGON|TSVECTOR|HSTORE)$/.test(b)) {
    ctx.warnings.add(`Columns of type ${b} are left NULL (no sample values for spatial or search types).`);
    return null;
  }
  ctx.warnings.add(`Unknown type ${col.type}: sample values are short words, which may not fit.`);
  return unique ? `${rng.pick(NOUNS)}_${i + 1}` : rng.pick(NOUNS);
}

/* ---------------- Literals ---------------- */

export function literal(v: RawValue, d: Diagram, info?: TypeInfo): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') {
    if (d.dialect === 'mariadb') return v ? '1' : '0';
    return v ? 'TRUE' : 'FALSE';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(Math.min(6, (String(v).split('.')[1] ?? '').length));
  if (typeof v === 'string') return quoteString(v);
  if ('hex' in v) {
    if (d.dialect === 'postgresql') return `'\\x${v.hex}'`;
    // DuckDB's blob literal spells every byte as \xNN.
    if (d.dialect === 'duckdb') return `'${(v.hex.match(/../g) ?? []).map((b) => `\\x${b}`).join('')}'::BLOB`;
    return `X'${v.hex}'`;
  }
  void info;
  return v.expr;
}

/* ---------------- Generator ---------------- */

interface FkLink {
  relationshipId: string;
  parentId: string;
  pairs: { columnId: string; parentColumnId: string }[];
  nullable: boolean;
  deferred: boolean;
}

/** The generated rows of one table, column by column. */
export interface SeedTableRows {
  table: Table;
  /** Columns that got values (unnamed columns are skipped), in table order. */
  columns: Column[];
  /** column id -> one value per row */
  store: Map<string, RawValue[]>;
  infos: Map<string, TypeInfo>;
  /** Number of rows generated (may be 0). */
  n: number;
}

export interface SeedRows {
  /** Tables in dependency order: parents before the tables that reference them. */
  tables: SeedTableRows[];
  rowCounts: Record<string, number>;
  warnings: string[];
}

/** A hint value coerced to what the column can hold; undefined when it cannot. */
function coerceHint(h: RawValue, info: TypeInfo, range: Range): RawValue | undefined {
  if (h === null || typeof h === 'object') return undefined;
  const text = typeof h === 'string' ? h : String(h);
  if (range.oneOf && !range.oneOf.includes(text)) return undefined;
  if (info.enumValues && !info.enumValues.includes(text)) return undefined;
  const numeric = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|NUMERIC|DECIMAL|DEC|REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|MONEY|YEAR)$/.test(info.base);
  if (numeric) {
    const n = typeof h === 'number' ? h : Number(text);
    if (!Number.isFinite(n)) return undefined;
    if (range.min !== undefined && n < range.min) return undefined;
    if (range.max !== undefined && n > range.max) return undefined;
    return n;
  }
  if (/^(BOOL|BOOLEAN)$/.test(info.base)) return typeof h === 'boolean' ? h : /^(true|t|1|yes)$/i.test(text);
  if (typeof h === 'boolean') return undefined;
  return clampText(text, info);
}

/**
 * Generate the rows without rendering them: the simulator reads these as the
 * raw input tables of a data flow, and generateSeed formats them as INSERTs.
 */
export function seedRows(d: Diagram, opts: SeedOptions = {}): SeedRows {
  const rows = Math.max(0, Math.floor(opts.rows ?? 10));
  const seed = opts.seed ?? 1;
  const nullRate = Math.min(1, Math.max(0, opts.nullRate ?? 0.1));
  const rng = new Rng(seed);
  const ctx: GenCtx = { d, rng, warnings: new Set() };
  const external = opts.includeExternal ? new Set<string>() : externalTableIds(d);
  const { order, deferred } = orderTables(d, external);
  const byId = new Map(d.tables.map((t) => [t.id, t] as const));
  /** tableId -> columnId -> values per row */
  const values = new Map<string, Map<string, RawValue[]>>();
  const rowCounts: Record<string, number> = {};
  const out: SeedTableRows[] = [];

  for (const t of order) {
    if (t.kind === 'view') continue;
    const columns = t.columns.filter((c) => c.name.trim());
    if (!columns.length) continue;
    let n = Math.max(0, Math.floor(opts.perTable?.[t.id] ?? rows));
    const infos = new Map(columns.map((c) => [c.id, typeInfo(d, c.type)] as const));
    const ranges = new Map(columns.map((c) => [c.id, rangeFromChecks(c, t)] as const));

    // foreign keys, grouped per relationship so composite keys stay consistent
    const links: FkLink[] = [];
    const fkColumnIds = new Set<string>();
    for (const r of d.relationships) {
      if (r.kind !== 'fk' || r.sourceTableId !== t.id) continue;
      const parent = byId.get(r.targetTableId);
      if (!parent || parent.kind === 'view') continue;
      const pairs = r.sourceColumnIds.map((cid, k) => ({ columnId: cid, parentColumnId: r.targetColumnIds[k] })).filter((p) => p.parentColumnId && columns.some((c) => c.id === p.columnId));
      if (!pairs.length) continue;
      for (const p of pairs) fkColumnIds.add(p.columnId);
      const nullable = pairs.every((p) => columns.find((c) => c.id === p.columnId)?.nullable);
      links.push({ relationshipId: r.id, parentId: parent.id, pairs, nullable, deferred: deferred.has(r.id) || external.has(parent.id) });
    }

    // unique sets: single unique columns, unique indexes, composite primary keys
    const pk = columns.filter((c) => c.primaryKey).map((c) => c.id);
    const uniqueSets: string[][] = [];
    for (const c of columns) if (c.unique || (c.primaryKey && pk.length === 1)) uniqueSets.push([c.id]);
    for (const ix of t.indexes) if (ix.unique && ix.columnIds.length) uniqueSets.push([...ix.columnIds]);
    if (pk.length > 1) uniqueSets.push(pk);
    const uniqueSingle = new Set(uniqueSets.filter((s) => s.length === 1).map((s) => s[0]));

    // A composite unique set made only of foreign-key columns (a join table) is
    // enumerated as a grid of parent combinations, so pairs never repeat.
    const gridSet = uniqueSets.find((s) => s.length > 1 && s.every((cid) => fkColumnIds.has(cid)));
    let gridLinks: FkLink[] = [];
    if (gridSet) {
      gridLinks = links.filter((l) => l.pairs.some((p) => gridSet.includes(p.columnId)) && !l.deferred);
      const capacity = gridLinks.reduce((acc, l) => acc * Math.max(1, rowCounts[l.parentId] ?? 0), 1);
      if (gridLinks.length && n > capacity) {
        ctx.warnings.add(`${t.name}: only ${capacity} distinct combinations of its parents exist, so it gets ${capacity} rows instead of ${n}.`);
        n = capacity;
      }
    }
    // A composite unique set with at least one plain column gets a distinct value there.
    const forcedUnique = new Set<string>();
    for (const s of uniqueSets) {
      if (s.length === 1 || s === gridSet) continue;
      const plain = s.find((cid) => !fkColumnIds.has(cid));
      if (plain) forcedUnique.add(plain);
      else if (!gridSet) ctx.warnings.add(`${t.name}: the unique key (${s.map((cid) => columns.find((c) => c.id === cid)?.name).join(', ')}) may repeat; only one join-table grid is enumerated per table.`);
    }

    const store = new Map<string, RawValue[]>();
    for (const c of columns) store.set(c.id, []);
    values.set(t.id, store);

    for (let i = 0; i < n; i++) {
      const row = new Map<string, RawValue>();
      // 1. foreign keys
      let gridIndex = i;
      for (const link of links) {
        const parentStore = values.get(link.parentId);
        const parentRows = rowCounts[link.parentId] ?? 0;
        let parentRow: number | null;
        if (link.deferred || !parentStore || parentRows === 0) {
          if (link.parentId === t.id) {
            parentRow = i === 0 ? null : rng.int(0, i - 1);
            if (parentRow === null && !link.nullable) parentRow = 0;
          } else {
            parentRow = null;
            if (!link.nullable) {
              const parent = byId.get(link.parentId);
              ctx.warnings.add(`${t.name} references ${parent?.name ?? '?'}, which is ${external.has(link.parentId) ? 'in another database' : 'generated later (reference cycle)'}; those columns are set to 1.`);
            }
          }
          for (const p of link.pairs) {
            const parentCol = byId.get(link.parentId)?.columns.find((c) => c.id === p.parentColumnId);
            const v = parentRow !== null && link.parentId === t.id ? (store.get(p.parentColumnId)?.[parentRow] ?? null) : null;
            row.set(p.columnId, v ?? (link.nullable ? null : parentCol && /INT|SERIAL/.test(normalizeType(parentCol.type)) ? 1 : `${parentCol?.name ?? 'ref'}_1`));
          }
          continue;
        }
        if (gridLinks.includes(link)) {
          parentRow = gridIndex % parentRows;
          gridIndex = Math.floor(gridIndex / parentRows);
        } else if (link.parentId === t.id) {
          parentRow = i === 0 || (link.nullable && rng.chance(0.3)) ? null : rng.int(0, i - 1);
          if (parentRow === null && !link.nullable && i > 0) parentRow = rng.int(0, i - 1);
        } else {
          parentRow = link.nullable && rng.chance(0.15) ? null : rng.int(0, parentRows - 1);
        }
        for (const p of link.pairs) row.set(p.columnId, parentRow === null ? null : (parentStore.get(p.parentColumnId)?.[parentRow] ?? null));
      }
      // 2. everything else
      for (const c of columns) {
        if (row.has(c.id)) continue;
        const info = infos.get(c.id)!;
        const range = ranges.get(c.id)!;
        const unique = uniqueSingle.has(c.id) || forcedUnique.has(c.id);
        const isPk = c.primaryKey;
        if (c.autoIncrement || (isPk && pk.length === 1 && /INT|SERIAL/.test(info.base))) {
          row.set(c.id, i + 1);
          continue;
        }
        if (!isPk && c.nullable && !unique && !range.oneOf && rng.chance(nullRate)) {
          row.set(c.id, null);
          continue;
        }
        // A value a data flow filters on shows up in roughly half the rows, so
        // the filter has both matches and misses to show.
        const hints = opts.valueHints?.[c.id];
        if (hints?.length && !unique) {
          const usable = hints.map((h) => coerceHint(h, info, range)).filter((h): h is RawValue => h !== undefined);
          if (usable.length && rng.chance(0.55)) {
            row.set(c.id, rng.pick(usable));
            continue;
          }
        }
        // A CHECK that pins the value down wins over what the name suggests.
        const constrained = Boolean(range.oneOf) || range.min !== undefined || range.max !== undefined;
        const named = constrained ? undefined : byName(ctx, t, c, info, i, unique);
        let v: RawValue;
        if (named !== undefined) {
          v = typeof named === 'number' && /^(DATE|TIME|TIMETZ|TIMESTAMP|TIMESTAMPTZ|DATETIME)$/.test(info.base) ? (info.base === 'DATE' ? fmtDate(named) : /^TIME/.test(info.base) && info.base !== 'TIMESTAMP' && info.base !== 'TIMESTAMPTZ' ? fmtTime(named) : fmtTimestamp(named)) : named;
          if (typeof v === 'string') v = clampText(v, info);
        } else v = byType(ctx, c, info, i, unique, range);
        if (v === null && !c.nullable) v = byType(ctx, c, info, i, unique, range) ?? '';
        row.set(c.id, v);
      }
      for (const c of columns) store.get(c.id)!.push(row.get(c.id) ?? null);
    }
    rowCounts[t.id] = n;
    out.push({ table: t, columns, store, infos, n });
  }
  return { tables: out, rowCounts, warnings: [...ctx.warnings] };
}

export function generateSeed(d: Diagram, opts: SeedOptions = {}): SeedResult {
  const seed = opts.seed ?? 1;
  const batchSize = Math.max(1, opts.batchSize ?? 50);
  const generated = seedRows(d, opts);
  const { rowCounts } = generated;
  const statements: string[] = [];
  const parts: string[] = [];
  const q = (n: string) => quoteIdent(n, d.dialect);
  const tn = (t: Table) => quoteQualified(t.name, t.schema, d.dialect);
  const sequenceFixes: string[] = [];

  for (const { table: t, columns, store, infos, n } of generated.tables) {
    if (n === 0) continue;
    const colList = columns.map((c) => q(c.name)).join(', ');
    const lines: string[] = [];
    for (let start = 0; start < n; start += batchSize) {
      const chunk: string[] = [];
      for (let i = start; i < Math.min(n, start + batchSize); i++) {
        chunk.push(`(${columns.map((c) => literal(store.get(c.id)![i], d, infos.get(c.id))).join(', ')})`);
      }
      const stmt = `INSERT INTO ${tn(t)} (${colList}) VALUES\n  ${chunk.join(',\n  ')};`;
      statements.push(stmt);
      lines.push(stmt);
    }
    parts.push(`-- ${t.name} (${n} row${n === 1 ? '' : 's'})\n${lines.join('\n')}`);
    if (d.dialect === 'duckdb') {
      // No setval() in DuckDB: draw one value per inserted row so the sequence sits past the ids above.
      for (const c of columns) {
        if (c.autoIncrement && isIntegerType(c.type)) sequenceFixes.push(`SELECT max(${sequenceDefault(t, c, d.dialect)}) FROM range(${n});`);
      }
    }
    if (d.dialect === 'postgresql') {
      for (const c of columns) {
        if (c.autoIncrement) sequenceFixes.push(`SELECT setval(pg_get_serial_sequence('${tn(t).replace(/'/g, "''")}', '${c.name.replace(/'/g, "''")}'), COALESCE(MAX(${q(c.name)}), 1)) FROM ${tn(t)};`);
      }
    }
  }

  if (sequenceFixes.length) {
    statements.push(...sequenceFixes);
    parts.push(`-- Move the sequences past the ids inserted above\n${sequenceFixes.join('\n')}`);
  }
  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  const label = engineName(d.dialect);
  const head = [
    `-- Seed data for ${d.name || 'Untitled diagram'} (${label})`,
    `-- Generated by Database Visualizer: ${totalRows} rows across ${Object.keys(rowCounts).length} tables, seed ${seed}. The same seed always gives the same rows.`,
    '-- Assumes the tables are empty: primary keys start at 1 and foreign keys point at the rows inserted here.',
  ];
  return { statements, script: [head.join('\n'), ...parts].join('\n\n') + '\n', warnings: generated.warnings, rowCounts, totalRows };
}
