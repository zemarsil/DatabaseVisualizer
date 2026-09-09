import { beforeEach, describe, expect, it } from 'vitest';
import type { Diagram } from '../src/shared/types';
import { createColumn, createExtension, createTable, emptyDiagram } from '../src/lib/model';
import { generateSchema } from '../src/lib/sql/generator';
import { importSql } from '../src/lib/sql/import';
import { parseSql } from '../src/lib/sql/parser';
import { lintDiagram } from '../src/lib/lint';
import { parseDiagramFile, parseWorkspaceFile, serializeDiagram, serializeWorkspace } from '../src/lib/io';
import { singleSheetWorkspace } from '../src/lib/model';
import { parseExtensionPack, serializeExtensionPack } from '../src/lib/extensions/packs';
import {
  addExtensionPack,
  extensionDefs,
  extensionIsUsed,
  extensionsProvidingType,
  extensionsUsedBy,
  findExtensionDef,
  resetExtensionRegistry,
  setLearnedExtensions,
  typeSuggestions,
} from '../src/lib/extensions/registry';
import { definitionsFromDatabase, packFromDatabase } from '../src/lib/extensions/fromDatabase';

/** A diagram with one table whose column needs an extension. */
function vectorDiagram(dialect: Diagram['dialect'] = 'postgresql'): Diagram {
  const d = emptyDiagram(dialect, 'search');
  const t = createTable({ name: 'docs' });
  t.columns.push(createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }));
  t.columns.push(createColumn({ name: 'embedding', type: 'vector(1536)' }));
  d.tables.push(t);
  return d;
}

function rules(d: Diagram): string[] {
  return lintDiagram(d).map((f) => f.rule);
}

// Packs persist in localStorage and definitions learned from a server live in a
// module-level cache; either would leak from one test into the next.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage in this environment */
  }
  resetExtensionRegistry();
});

describe('the bundled catalog', () => {
  it('knows which extension provides a type, and offers it once enabled', () => {
    const providers = extensionsProvidingType('vector(1536)', 'postgresql');
    expect(providers.map((p) => p.name)).toContain('vector');

    const d = vectorDiagram();
    expect(typeSuggestions(d)).not.toContain('vector(1536)');
    d.extensions.push(createExtension({ name: 'vector' }));
    expect(typeSuggestions(d)).toContain('vector(1536)');
    // The dialect's own types are still there.
    expect(typeSuggestions(d)).toContain('JSONB');
  });

  it('keeps each engine to its own definitions', () => {
    expect(findExtensionDef('postgis', 'postgresql')).toBeTruthy();
    expect(findExtensionDef('postgis', 'mariadb')).toBeUndefined();
    expect(extensionDefs('sqlite').map((d) => d.name)).toContain('fts5');
  });

  it('matches names case-insensitively, the way the engines do', () => {
    expect(findExtensionDef('PostGIS', 'postgresql')?.name).toBe('postgis');
  });

  it('reports an extension as used only when something names what it provides', () => {
    const def = findExtensionDef('vector', 'postgresql')!;
    expect(extensionIsUsed(vectorDiagram(), def)).toBe(true);
    expect(extensionIsUsed(emptyDiagram(), def)).toBe(false);

    // An extension that provides nothing nameable can never be shown unused.
    const stats = findExtensionDef('pg_stat_statements', 'postgresql')!;
    expect(extensionIsUsed(emptyDiagram(), stats)).toBe(true);
  });
});

describe('generated SQL', () => {
  it('creates PostgreSQL extensions before the tables that need them', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'vector' }));
    const { statements, script, warnings } = generateSchema(d);
    expect(statements[0]).toBe('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(script.indexOf('CREATE EXTENSION')).toBeLessThan(script.indexOf('CREATE TABLE'));
    expect(warnings).toHaveLength(0);
  });

  it('carries the schema and version through, and quotes a name that needs it', () => {
    const d = emptyDiagram('postgresql');
    d.extensions.push(createExtension({ name: 'uuid-ossp', schema: 'extensions', version: '1.1' }));
    expect(generateSchema(d).statements[0]).toBe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions VERSION '1.1';`);
  });

  it('runs before CREATE TYPE, since a custom type can be built on an extension type', () => {
    const d = emptyDiagram('postgresql');
    d.extensions.push(createExtension({ name: 'citext' }));
    d.customTypes.push({ id: 'ct1', name: 'status', kind: 'enum', values: ['a'] });
    const { script } = generateSchema(d);
    expect(script.indexOf('CREATE EXTENSION')).toBeLessThan(script.indexOf('CREATE TYPE'));
  });

  it('writes a MariaDB plugin as a comment rather than a statement', () => {
    const d = emptyDiagram('mariadb');
    d.extensions.push(createExtension({ name: 'ha_connect' }));
    const { statements, script, warnings } = generateSchema(d);
    // INSTALL SONAME is server-wide and needs SUPER; running it with a schema
    // would let it roll back an otherwise fine apply.
    expect(statements.some((s) => s.includes('INSTALL SONAME'))).toBe(false);
    expect(script).toContain("--   INSTALL SONAME 'ha_connect';");
    expect(warnings.join(' ')).toMatch(/not into a database/);
  });

  it('writes an SQLite module as a comment, since the client loads it', () => {
    const d = emptyDiagram('sqlite');
    d.extensions.push(createExtension({ name: 'spatialite' }));
    const { statements, script, warnings } = generateSchema(d);
    expect(statements).toHaveLength(0);
    expect(script).toContain('-- spatialite: load this module in the client');
    expect(warnings.join(' ')).toMatch(/in-browser engine cannot load it/);
  });

  it('generates nothing for something the engine already has', () => {
    const d = emptyDiagram('postgresql');
    d.extensions.push(createExtension({ name: 'plpgsql' }));
    const { statements, script } = generateSchema(d);
    expect(statements).toHaveLength(0);
    expect(script).toContain('-- plpgsql is built into the engine');
  });

  it('names the extensions in the script header', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'vector' }));
    expect(generateSchema(d).script).toContain('-- Extensions: vector');
  });
});

describe('lint', () => {
  it('flags a column typed with something no enabled extension provides, and fixes it', () => {
    const d = vectorDiagram();
    expect(rules(d)).toContain('type-needs-extension');

    const finding = lintDiagram(d).find((f) => f.rule === 'type-needs-extension')!;
    expect(finding.severity).toBe('error');
    expect(finding.message).toContain('vector');
    const copy = structuredClone(d);
    finding.fix!.apply(copy);
    expect(copy.extensions.map((e) => e.name)).toEqual(['vector']);
    expect(rules(copy)).not.toContain('type-needs-extension');
  });

  it("leaves the engine's own types alone", () => {
    const d = emptyDiagram('postgresql');
    const t = createTable({ name: 'events' });
    t.columns.push(createColumn({ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }));
    t.columns.push(createColumn({ name: 'payload', type: 'JSONB' }));
    t.columns.push(createColumn({ name: 'tags', type: 'TEXT[]' }));
    d.tables.push(t);
    expect(rules(d)).not.toContain('type-needs-extension');
  });

  it('does not flag a type the diagram defines itself', () => {
    const d = vectorDiagram();
    d.tables[0].columns[1].type = 'vector';
    d.customTypes.push({ id: 'ct1', name: 'vector', kind: 'composite', fields: [] });
    expect(rules(d)).not.toContain('type-needs-extension');

    // With arguments it cannot be that custom type — SQL has no parameterised
    // CREATE TYPE — so it is the extension's type and still needs the extension.
    d.tables[0].columns[1].type = 'vector(1536)';
    expect(rules(d)).toContain('type-needs-extension');
  });

  it('reports each type once per table rather than once per column', () => {
    const d = vectorDiagram();
    d.tables[0].columns.push(createColumn({ name: 'title_embedding', type: 'vector(384)' }));
    expect(rules(d).filter((r) => r === 'type-needs-extension')).toHaveLength(1);
  });

  it('requires an extension another one depends on, and adds it ahead of the dependant', () => {
    const d = emptyDiagram('postgresql');
    d.extensions.push(createExtension({ name: 'earthdistance' }));
    const finding = lintDiagram(d).find((f) => f.rule === 'extension-missing-requirement')!;
    expect(finding.message).toContain('cube');
    const copy = structuredClone(d);
    finding.fix!.apply(copy);
    expect(copy.extensions.map((e) => e.name)).toEqual(['cube', 'earthdistance']);
  });

  it('flags the same extension listed twice', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'vector' }), createExtension({ name: 'VECTOR' }));
    expect(rules(d).filter((r) => r === 'duplicate-extension')).toHaveLength(2);
  });

  it('notes an extension nothing uses, and one nothing defines', () => {
    const d = emptyDiagram('postgresql');
    d.extensions.push(createExtension({ name: 'hstore' }), createExtension({ name: 'nobody_has_heard_of_this' }));
    expect(rules(d)).toContain('extension-unused');
    expect(rules(d)).toContain('extension-unknown');
  });
});

describe('reading extensions out of SQL', () => {
  it('parses CREATE EXTENSION with its options', () => {
    const res = parseSql(
      `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions VERSION '1.1';
       CREATE EXTENSION postgis CASCADE;
       CREATE TABLE t (id INTEGER PRIMARY KEY);`,
      'postgresql',
    );
    expect(res.extensions).toEqual([
      { name: 'uuid-ossp', schema: 'extensions', version: '1.1' },
      { name: 'postgis', schema: undefined, version: undefined },
    ]);
    expect(res.warnings.filter((w) => /EXTENSION/i.test(w.message))).toEqual([]);
  });

  it('records an extension once however many times the script enables it', () => {
    const res = parseSql('CREATE EXTENSION postgis; CREATE EXTENSION IF NOT EXISTS PostGIS;', 'postgresql');
    expect(res.extensions).toHaveLength(1);
  });

  it('parses both MariaDB INSTALL forms and drops the library suffix', () => {
    expect(parseSql("INSTALL SONAME 'ha_connect.so';", 'mariadb').extensions).toEqual([{ name: 'ha_connect' }]);
    expect(parseSql("INSTALL PLUGIN Spider SONAME 'ha_spider.so';", 'mariadb').extensions).toEqual([{ name: 'ha_spider' }]);
  });

  it('brings them into an imported diagram', () => {
    const res = importSql('CREATE EXTENSION vector; CREATE TABLE docs (id INTEGER PRIMARY KEY, e vector(3));', 'postgresql');
    expect(res.extensions.map((e) => e.name)).toEqual(['vector']);
    expect(res.extensions[0].id).toMatch(/^ext/);
  });

  it('does not re-add one the diagram already declares', () => {
    const existing = emptyDiagram('postgresql');
    existing.extensions.push(createExtension({ name: 'vector', comment: 'for embeddings' }));
    const res = importSql('CREATE EXTENSION vector; CREATE TABLE t (id INTEGER PRIMARY KEY);', 'postgresql', existing);
    expect(res.extensions).toHaveLength(0);
  });
});

describe('the file format', () => {
  it('round-trips extensions', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'vector', schema: 'ext', version: '0.7.0', comment: 'embeddings' }));
    const back = parseDiagramFile(serializeDiagram(d));
    expect(back.extensions).toEqual(d.extensions);
  });

  it('reads a file written before extensions existed as having none', () => {
    const back = parseDiagramFile(JSON.stringify({ version: 1, name: 'old', dialect: 'postgresql', tables: [] }));
    expect(back.extensions).toEqual([]);
  });

  it('drops junk entries and keeps the first of a repeated name', () => {
    const back = parseDiagramFile(
      JSON.stringify({
        version: 1,
        name: 'x',
        dialect: 'postgresql',
        tables: [],
        extensions: [{ name: 'vector', comment: 'first' }, 'not an object', { name: '  ' }, { name: 'VECTOR', comment: 'second' }],
      }),
    );
    expect(back.extensions).toHaveLength(1);
    expect(back.extensions[0].comment).toBe('first');
    // A file with no id still loads; one is assigned.
    expect(back.extensions[0].id).toMatch(/^ext/);
  });

  it('round-trips through a workspace of several sheets', () => {
    const a = vectorDiagram();
    a.extensions.push(createExtension({ name: 'vector' }));
    const b = emptyDiagram('postgresql', 'other');
    b.extensions.push(createExtension({ name: 'hstore' }));
    const ws = singleSheetWorkspace(a);
    ws.name = 'work';
    ws.sheets.push({ id: 'sht2', diagram: b });
    const back = parseWorkspaceFile(serializeWorkspace(ws));
    expect(back.sheets.map((s) => s.diagram.extensions.map((e) => e.name))).toEqual([['vector'], ['hstore']]);
  });
});

describe('copying tables out', () => {
  it('takes the extensions those tables depend on with them', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'vector' }), createExtension({ name: 'hstore' }));
    const used = extensionsUsedBy(d, d.tables);
    expect(used.map((e) => e.name)).toEqual(['vector']);
  });

  it('keeps an extension nothing defines, rather than dropping a dependency', () => {
    const d = vectorDiagram();
    d.extensions.push(createExtension({ name: 'something_internal' }));
    expect(extensionsUsedBy(d, d.tables).map((e) => e.name)).toEqual(['something_internal']);
  });
});

describe('definition packs', () => {
  const PACK = JSON.stringify({
    format: 'dbviz-extension-pack',
    version: 1,
    id: 'test-pack',
    name: 'Test pack',
    dialect: 'postgresql',
    extensions: [
      { name: 'h3', label: 'H3', summary: 'Hexagonal grid indexing.', types: ['h3index'], functions: ['h3_lat_lng_to_cell'], indexMethods: ['btree'] },
      { name: 'shorthand', types: [{ name: 'thing', example: 'thing(4)' }] },
    ],
  });

  it('loads a pack and lets its definitions answer questions', () => {
    const { pack, errors } = parseExtensionPack(PACK, { origin: 'test.json' });
    expect(errors).toEqual([]);
    expect(pack!.extensions).toHaveLength(2);
    addExtensionPack(pack!);

    expect(findExtensionDef('h3', 'postgresql')?.label).toBe('H3');
    expect(extensionsProvidingType('h3index', 'postgresql').map((p) => p.name)).toEqual(['h3']);
    // Types given as bare strings are shorthand for { name }.
    expect(findExtensionDef('h3', 'postgresql')?.types).toEqual([{ name: 'h3index' }]);
  });

  it('lets a pack override a bundled definition', () => {
    addExtensionPack(
      parseExtensionPack(
        JSON.stringify({
          format: 'dbviz-extension-pack',
          id: 'override',
          name: 'Override',
          extensions: [{ name: 'vector', dialect: 'postgresql', summary: 'from a pack', types: ['bespoke'] }],
        }),
      ).pack!,
    );
    const def = findExtensionDef('vector', 'postgresql')!;
    expect(def.summary).toBe('from a pack');
    expect(def.types).toEqual([{ name: 'bespoke' }]);
  });

  it('refuses a file that is not a pack, with a reason', () => {
    expect(parseExtensionPack('not json').errors[0]).toMatch(/not valid JSON/);
    expect(parseExtensionPack('{"format":"something-else","extensions":[]}').errors[0]).toMatch(/must say/);
    expect(parseExtensionPack('{"format":"dbviz-extension-pack"}').errors[0]).toMatch(/no "extensions" array/);
  });

  it('drops an unusable entry but keeps the rest', () => {
    const { pack, errors } = parseExtensionPack(
      JSON.stringify({
        format: 'dbviz-extension-pack',
        id: 'mixed',
        name: 'Mixed',
        extensions: [{ dialect: 'postgresql' }, { name: 'ok', dialect: 'postgresql' }, { name: 'bad', dialect: 'oracle' }],
      }),
    );
    expect(pack!.extensions.map((e) => e.name)).toEqual(['ok']);
    expect(errors).toHaveLength(2);
  });

  it('round-trips through its own serializer', () => {
    const { pack } = parseExtensionPack(PACK);
    const again = parseExtensionPack(serializeExtensionPack(pack!));
    expect(again.pack!.extensions.map((e) => e.name)).toEqual(['h3', 'shorthand']);
  });
});

describe('definitions read off a live server', () => {
  const RESPONSE = {
    serverVersion: 'PostgreSQL 16.2',
    extensions: [
      {
        name: 'postgis',
        installed: true,
        installedVersion: '3.4.2',
        schema: 'public',
        comment: 'PostGIS geometry and geography types',
        types: ['geometry', 'geography'],
        functions: ['st_distance', 'st_dwithin'],
        functionCount: 1200,
        indexMethods: ['gist'],
      },
      { name: 'vector', installed: false, defaultVersion: '0.7.0' },
    ],
  };

  it('turns what the server reports into usable definitions', () => {
    const defs = definitionsFromDatabase(RESPONSE, 'postgresql');
    // Only installed extensions can say what they provide.
    expect(defs.map((d) => d.name)).toEqual(['postgis']);
    expect(defs[0].types).toEqual([{ name: 'geometry' }, { name: 'geography' }]);
    expect(defs[0].note).toContain('2 of its 1200 functions');
  });

  it('keeps the curated prose and type list when one exists', () => {
    setLearnedExtensions(definitionsFromDatabase(RESPONSE, 'postgresql'));
    const def = findExtensionDef('postgis', 'postgresql')!;
    expect(def.source).toBe('database');
    // A server has no summaries, no docs link and no examples, and reports
    // internal GiST support types beside the real ones, so the bundled entry's
    // prose and curated type list survive the merge.
    expect(def.label).toBe('PostGIS');
    expect(def.docsUrl).toContain('postgis.net');
    expect(def.types?.map((t) => t.name)).toContain('geometry');
    expect(def.types?.some((t) => t.example)).toBe(true);
    // What only the server can know does come through.
    expect(def.indexMethods).toEqual(['gist']);
  });

  it('takes a server definition whole for an extension nothing else describes', () => {
    setLearnedExtensions(
      definitionsFromDatabase(
        { serverVersion: 'PostgreSQL 16.2', extensions: [{ name: 'h3', installed: true, types: ['h3index'], comment: 'Hexagonal indexing' }] },
        'postgresql',
      ),
    );
    const def = findExtensionDef('h3', 'postgresql')!;
    expect(def.summary).toBe('Hexagonal indexing');
    expect(def.types).toEqual([{ name: 'h3index' }]);
    expect(extensionsProvidingType('h3index', 'postgresql').map((p) => p.name)).toEqual(['h3']);
  });

  it('packages them so they survive a reload', () => {
    const pack = packFromDatabase(RESPONSE, 'postgresql', 'app@127.0.0.1:5432');
    expect(pack.extensions.map((e) => e.packId)).toEqual([pack.id]);
    // A pack it writes is a pack it can read.
    expect(parseExtensionPack(serializeExtensionPack(pack)).pack!.extensions).toHaveLength(1);
  });
});

describe('the example pack that ships in docs/', () => {
  it('loads with no errors, which is what makes it worth pointing people at', async () => {
    const fs = await import('node:fs/promises');
    const json = await fs.readFile(new URL('../docs/examples/postgres-extras.extpack.json', import.meta.url), 'utf8');
    const { pack, errors, warnings } = parseExtensionPack(json, { origin: 'postgres-extras.extpack.json' });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(pack!.extensions.map((e) => e.name)).toEqual(['pgroonga', 'pg_partman', 'temporal_tables']);
    // The top-level dialect stands in for every entry.
    expect(pack!.extensions.every((e) => e.dialect === 'postgresql')).toBe(true);
  });
});
