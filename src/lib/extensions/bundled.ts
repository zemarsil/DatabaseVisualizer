/**
 * Definitions for the extensions people reach for most often, shipped with the
 * app so the common cases work with no network and no setup.
 *
 * This list is deliberately not exhaustive, and it never needs to be: it is one
 * of three sources the registry merges, alongside packs the user loads
 * (src/lib/extensions/packs.ts) and definitions read straight off a live server
 * (src/lib/extensions/fromDatabase.ts). An extension missing from here is still
 * usable — declare it by name and the DDL comes out right — it just gets no
 * autocomplete or lint help until a definition turns up.
 *
 * What belongs in an entry: the things the app can *act on*. Types feed column
 * autocomplete, functions feed DEFAULT suggestions, index methods and operator
 * classes are what a reader needs to know the extension is pulling its weight.
 * Everything else belongs in `summary` or `note`.
 */
import type { ExtensionDef } from '@shared/types';

/* ------------------------------------------------------------------ */
/* PostgreSQL                                                          */
/* ------------------------------------------------------------------ */

const POSTGRES: ExtensionDef[] = [
  {
    name: 'postgis',
    dialect: 'postgresql',
    label: 'PostGIS',
    summary: 'Geographic objects: points, lines and polygons with spatial indexes and coordinate systems.',
    docsUrl: 'https://postgis.net/documentation/',
    types: [
      { name: 'geometry', example: 'geometry(Point,4326)', summary: 'A shape on a flat plane, optionally pinned to an SRID (4326 is WGS 84 lat/long).' },
      { name: 'geography', example: 'geography(Point,4326)', summary: 'The same shapes measured on the spheroid, so distances come back in metres.' },
      { name: 'box2d', summary: 'A 2D bounding box.' },
      { name: 'box3d', summary: 'A 3D bounding box.' },
    ],
    functions: [
      { name: 'ST_Distance', example: 'ST_Distance(a, b)', summary: 'Distance between two shapes.' },
      { name: 'ST_DWithin', example: 'ST_DWithin(a, b, 1000)', summary: 'True when two shapes are within a distance; the form a GiST index can use.' },
      { name: 'ST_Contains', example: 'ST_Contains(a, b)' },
      { name: 'ST_Intersects', example: 'ST_Intersects(a, b)' },
      { name: 'ST_MakePoint', example: 'ST_MakePoint(lon, lat)' },
      { name: 'ST_SetSRID', example: 'ST_SetSRID(ST_MakePoint(lon, lat), 4326)' },
      { name: 'ST_AsGeoJSON', example: 'ST_AsGeoJSON(geom)' },
    ],
    note: 'Indexed with the built-in GiST (or SP-GiST, or BRIN) using the operator classes it installs. Installs several thousand functions and a spatial_ref_sys table. Enabling it needs privileges most application roles do not have.',
  },
  {
    name: 'postgis_raster',
    dialect: 'postgresql',
    label: 'PostGIS Raster',
    summary: 'Raster (gridded) data alongside PostGIS vector shapes.',
    docsUrl: 'https://postgis.net/docs/RT_reference.html',
    types: [{ name: 'raster', summary: 'A grid of cells with a georeference.' }],
    requires: ['postgis'],
  },
  {
    name: 'vector',
    dialect: 'postgresql',
    label: 'pgvector',
    summary: 'Vector columns and approximate nearest-neighbour indexes: the usual way to store embeddings in PostgreSQL.',
    docsUrl: 'https://github.com/pgvector/pgvector',
    types: [
      { name: 'vector', example: 'vector(1536)', summary: 'A fixed-length array of 4-byte floats. The length is part of the type and cannot be left off for an indexed column.' },
      { name: 'halfvec', example: 'halfvec(1536)', summary: 'The same, at half precision: half the storage, slightly less accuracy.' },
      { name: 'sparsevec', example: 'sparsevec(1536)', summary: 'Stores only the non-zero elements.' },
    ],
    functions: [
      { name: 'l2_distance', example: 'l2_distance(a, b)', summary: 'Euclidean distance; the <-> operator.' },
      { name: 'cosine_distance', example: 'cosine_distance(a, b)', summary: '1 minus cosine similarity; the <=> operator.' },
      { name: 'inner_product', example: 'inner_product(a, b)', summary: 'Negative inner product; the <#> operator.' },
    ],
    indexMethods: ['hnsw', 'ivfflat'],
    operatorClasses: ['vector_l2_ops', 'vector_cosine_ops', 'vector_ip_ops', 'halfvec_l2_ops', 'halfvec_cosine_ops'],
    note: 'An index must name the operator class matching the distance you query with — a cosine index does nothing for an L2 query.',
  },
  {
    name: 'pg_trgm',
    dialect: 'postgresql',
    label: 'pg_trgm',
    summary: "Trigram similarity: fuzzy matching, and the piece that makes an unanchored LIKE '%foo%' indexable.",
    docsUrl: 'https://www.postgresql.org/docs/current/pgtrgm.html',
    functions: [
      { name: 'similarity', example: 'similarity(a, b)', summary: '0 to 1, how many trigrams two strings share.' },
      { name: 'word_similarity', example: 'word_similarity(a, b)' },
      { name: 'show_trgm', example: 'show_trgm(text)', summary: 'The trigrams a string breaks into; useful when a match surprises you.' },
    ],
    operatorClasses: ['gin_trgm_ops', 'gist_trgm_ops'],
    note: 'Adds no types. A GIN index with gin_trgm_ops is what turns an unanchored LIKE or ILIKE from a sequential scan into an index scan.',
  },
  {
    name: 'hstore',
    dialect: 'postgresql',
    label: 'hstore',
    summary: 'A flat string-to-string map in one column. Predates JSONB; JSONB is the better default for new schemas.',
    docsUrl: 'https://www.postgresql.org/docs/current/hstore.html',
    types: [{ name: 'hstore', summary: 'Key/value pairs, both sides text, no nesting.' }],
    operatorClasses: ['gin_hstore_ops', 'gist_hstore_ops'],
  },
  {
    name: 'citext',
    dialect: 'postgresql',
    label: 'citext',
    summary: 'Text that compares case-insensitively, so an email column can be unique without a lower() index.',
    docsUrl: 'https://www.postgresql.org/docs/current/citext.html',
    types: [{ name: 'citext', summary: 'Behaves like text, but = and unique indexes ignore case.' }],
  },
  {
    name: 'uuid-ossp',
    dialect: 'postgresql',
    label: 'uuid-ossp',
    summary: 'UUID generators. Only worth enabling for v1/v3/v5 — PostgreSQL 13 and later have gen_random_uuid() built in.',
    docsUrl: 'https://www.postgresql.org/docs/current/uuid-ossp.html',
    functions: [
      { name: 'uuid_generate_v4', example: 'uuid_generate_v4()', summary: 'Random UUID. gen_random_uuid() does the same with no extension on PG 13+.' },
      { name: 'uuid_generate_v1', example: 'uuid_generate_v1()', summary: 'Time and MAC based, so it leaks both but sorts roughly by creation time.' },
      { name: 'uuid_generate_v5', example: "uuid_generate_v5(uuid_ns_url(), 'https://example.com')", summary: 'Deterministic from a namespace and a name.' },
    ],
    note: 'The name has a hyphen, so it needs quoting: CREATE EXTENSION "uuid-ossp".',
  },
  {
    name: 'pgcrypto',
    dialect: 'postgresql',
    label: 'pgcrypto',
    summary: 'Hashing, password crypt() and symmetric/PGP encryption inside the database.',
    docsUrl: 'https://www.postgresql.org/docs/current/pgcrypto.html',
    functions: [
      { name: 'gen_random_uuid', example: 'gen_random_uuid()', summary: 'Built into PostgreSQL 13 and later; the extension is only needed below that.' },
      { name: 'crypt', example: "crypt(password, gen_salt('bf'))", summary: 'Password hashing with a salt the function embeds in the output.' },
      { name: 'gen_salt', example: "gen_salt('bf', 8)" },
      { name: 'digest', example: "digest(data, 'sha256')" },
      { name: 'pgp_sym_encrypt', example: 'pgp_sym_encrypt(data, key)' },
    ],
    note: 'Encrypting in the database means the key passes through the server and lands in the query log unless you are careful.',
  },
  {
    name: 'ltree',
    dialect: 'postgresql',
    label: 'ltree',
    summary: 'Materialised paths for tree data: "top.science.astronomy" as a first-class type with ancestor queries.',
    docsUrl: 'https://www.postgresql.org/docs/current/ltree.html',
    types: [
      { name: 'ltree', example: 'ltree', summary: 'A dotted label path, e.g. top.science.astronomy.' },
      { name: 'lquery', summary: 'A pattern matched against an ltree.' },
      { name: 'ltxtquery', summary: 'A full-text style query over label paths.' },
    ],
    note: 'Indexed with the built-in GiST. A good fit when the tree is read far more often than it is re-parented; moving a subtree rewrites every descendant path.',
  },
  {
    name: 'cube',
    dialect: 'postgresql',
    label: 'cube',
    summary: 'Multidimensional cubes and points, with GiST indexing for nearest-neighbour searches.',
    docsUrl: 'https://www.postgresql.org/docs/current/cube.html',
    types: [{ name: 'cube', summary: 'A point or a box in N dimensions.' }],
    note: 'Indexed with the built-in GiST, which is what makes a nearest-neighbour search on it cheap.',
  },
  {
    name: 'earthdistance',
    dialect: 'postgresql',
    label: 'earthdistance',
    summary: 'Great-circle distances on a sphere. Lighter than PostGIS when all you need is "how far apart".',
    docsUrl: 'https://www.postgresql.org/docs/current/earthdistance.html',
    functions: [
      { name: 'll_to_earth', example: 'll_to_earth(lat, lon)' },
      { name: 'earth_distance', example: 'earth_distance(ll_to_earth(a_lat, a_lon), ll_to_earth(b_lat, b_lon))' },
    ],
    requires: ['cube'],
  },
  {
    name: 'btree_gin',
    dialect: 'postgresql',
    label: 'btree_gin',
    summary: 'GIN operator classes for ordinary scalar types, so one GIN index can cover a jsonb column and an int alongside it.',
    docsUrl: 'https://www.postgresql.org/docs/current/btree-gin.html',
    note: 'Adds no index method of its own: it teaches the built-in GIN about types it could not index before.',
  },
  {
    name: 'btree_gist',
    dialect: 'postgresql',
    label: 'btree_gist',
    summary: 'GiST operator classes for scalar types. The usual reason to enable it is an exclusion constraint mixing a range with an equality column.',
    docsUrl: 'https://www.postgresql.org/docs/current/btree-gist.html',
    note: 'Adds no index method of its own: it teaches the built-in GiST about types it could not index before.',
  },
  {
    name: 'unaccent',
    dialect: 'postgresql',
    label: 'unaccent',
    summary: 'Strips accents, so "café" and "cafe" match. A text-search dictionary and a plain function.',
    docsUrl: 'https://www.postgresql.org/docs/current/unaccent.html',
    functions: [{ name: 'unaccent', example: "unaccent('café')" }],
    note: 'unaccent() is only marked immutable in a wrapper you write yourself, which is what an expression index on it requires.',
  },
  {
    name: 'intarray',
    dialect: 'postgresql',
    label: 'intarray',
    summary: 'Faster operators and GIN/GiST support for arrays of integers.',
    docsUrl: 'https://www.postgresql.org/docs/current/intarray.html',
    operatorClasses: ['gin__int_ops', 'gist__int_ops'],
  },
  {
    name: 'pg_stat_statements',
    dialect: 'postgresql',
    label: 'pg_stat_statements',
    summary: 'Records every statement shape with its call count and total time. The first thing to reach for when asking what is slow.',
    docsUrl: 'https://www.postgresql.org/docs/current/pgstatstatements.html',
    note: 'Also needs the library in shared_preload_libraries and a server restart, which CREATE EXTENSION alone does not do.',
  },
  {
    name: 'timescaledb',
    dialect: 'postgresql',
    label: 'TimescaleDB',
    summary: 'Turns a table into a hypertable partitioned by time, with compression and continuous aggregates.',
    docsUrl: 'https://docs.timescale.com/',
    functions: [
      { name: 'create_hypertable', example: "create_hypertable('readings', 'taken_at')", summary: 'Run once per table, after CREATE TABLE.' },
      { name: 'time_bucket', example: "time_bucket('1 hour', taken_at)", summary: 'Rounds timestamps down to a bucket; the grouping key for most time-series queries.' },
    ],
    note: 'Needs the library preloaded. A hypertable is still a table here — the diagram draws it normally and create_hypertable() belongs in a note or a flow query.',
  },
  {
    name: 'age',
    dialect: 'postgresql',
    label: 'Apache AGE',
    summary: 'Property graphs and openCypher queries inside PostgreSQL.',
    docsUrl: 'https://age.apache.org/age-manual/master/index.html',
    types: [{ name: 'agtype', summary: 'The value type every Cypher query returns.' }],
    note: 'Graphs live in their own schemas rather than as ordinary tables, so most of an AGE model is invisible to a table diagram.',
  },
  {
    name: 'postgres_fdw',
    dialect: 'postgresql',
    label: 'postgres_fdw',
    summary: 'Foreign tables backed by another PostgreSQL server: query it as if its tables were local.',
    docsUrl: 'https://www.postgresql.org/docs/current/postgres-fdw.html',
    note: 'The tables it exposes belong to another database. Put them in an external group so the script documents them instead of creating them.',
  },
  {
    name: 'plpgsql',
    dialect: 'postgresql',
    label: 'PL/pgSQL',
    summary: 'The procedural language for functions and triggers. Installed in every new database already.',
    docsUrl: 'https://www.postgresql.org/docs/current/plpgsql.html',
    install: 'built-in',
    note: 'Listing it is harmless but never necessary; CREATE EXTENSION IF NOT EXISTS plpgsql is a no-op.',
  },
];

/* ------------------------------------------------------------------ */
/* MariaDB                                                             */
/* ------------------------------------------------------------------ */

/**
 * MariaDB has no CREATE EXTENSION. The equivalent is a plugin loaded with
 * INSTALL SONAME, which mostly means a storage engine rather than new types, so
 * these entries carry engines and behaviour rather than types.
 */
const MARIADB: ExtensionDef[] = [
  {
    name: 'ha_connect',
    dialect: 'mariadb',
    label: 'CONNECT storage engine',
    summary: "Tables backed by outside data: CSV, XML, JSON, ODBC, or another server's table.",
    docsUrl: 'https://mariadb.com/kb/en/connect/',
    install: 'install-soname',
    note: 'Create the table with ENGINE=CONNECT. Like a foreign data wrapper, the rows are not yours — an external group fits them.',
  },
  {
    name: 'ha_spider',
    dialect: 'mariadb',
    label: 'Spider storage engine',
    summary: 'Shards a table across several MariaDB servers behind one table name.',
    docsUrl: 'https://mariadb.com/kb/en/spider/',
    install: 'install-soname',
  },
  {
    name: 'ha_mroonga',
    dialect: 'mariadb',
    label: 'Mroonga',
    summary: 'Full-text search that handles CJK text properly, where the built-in FULLTEXT index does not.',
    docsUrl: 'https://mariadb.com/kb/en/mroonga/',
    install: 'install-soname',
  },
  {
    name: 'ha_oqgraph',
    dialect: 'mariadb',
    label: 'OQGRAPH',
    summary: 'Tree and graph traversal (shortest path, ancestors) as a storage engine over an edge table.',
    docsUrl: 'https://mariadb.com/kb/en/oqgraph-storage-engine/',
    install: 'install-soname',
  },
  {
    name: 'ha_s3',
    dialect: 'mariadb',
    label: 'S3 storage engine',
    summary: 'Read-only archived tables kept in S3-compatible object storage.',
    docsUrl: 'https://mariadb.com/kb/en/s3-storage-engine/',
    install: 'install-soname',
  },
  {
    name: 'simple_password_check',
    dialect: 'mariadb',
    label: 'simple_password_check',
    summary: 'Rejects weak passwords at CREATE USER time.',
    docsUrl: 'https://mariadb.com/kb/en/simple_password_check-plugin/',
    install: 'install-soname',
  },
];

/* ------------------------------------------------------------------ */
/* SQLite                                                              */
/* ------------------------------------------------------------------ */

/**
 * SQLite modules are compiled into the library or loaded by the client before it
 * opens the file. Neither is a statement the schema can carry, so these generate
 * a comment rather than SQL — but declaring one still documents the dependency,
 * and still teaches the type autocomplete what the module adds.
 */
const SQLITE: ExtensionDef[] = [
  {
    name: 'fts5',
    dialect: 'sqlite',
    label: 'FTS5 (full-text search)',
    summary: 'Full-text search over a virtual table, with ranking.',
    docsUrl: 'https://sqlite.org/fts5.html',
    install: 'built-in',
    functions: [
      { name: 'bm25', example: 'bm25(docs_fts)', summary: 'Relevance score; lower is better, so ORDER BY bm25(...) ascending.' },
      { name: 'highlight', example: "highlight(docs_fts, 0, '<b>', '</b>')" },
      { name: 'snippet', example: "snippet(docs_fts, 0, '<b>', '</b>', '…', 16)" },
    ],
    note: 'An FTS5 table is created with CREATE VIRTUAL TABLE, which this app does not generate — model it as a view or a note and keep the real statement beside it.',
  },
  {
    name: 'rtree',
    dialect: 'sqlite',
    label: 'R*Tree',
    summary: 'A spatial index module for bounding-box queries.',
    docsUrl: 'https://sqlite.org/rtree.html',
    install: 'built-in',
  },
  {
    name: 'json1',
    dialect: 'sqlite',
    label: 'JSON1',
    summary: 'JSON functions. Compiled in by default since SQLite 3.38, so it is rarely something you enable.',
    docsUrl: 'https://sqlite.org/json1.html',
    install: 'built-in',
    functions: [
      { name: 'json_extract', example: "json_extract(payload, '$.id')" },
      { name: 'json_each', example: 'json_each(payload)' },
    ],
  },
  {
    name: 'spatialite',
    dialect: 'sqlite',
    label: 'SpatiaLite',
    summary: 'PostGIS-style geometry for SQLite, loaded as a shared library.',
    docsUrl: 'https://www.gaia-gis.it/fossil/libspatialite/index',
    install: 'client-loaded',
    types: [{ name: 'GEOMETRY', summary: 'Stored as a BLOB; the column is registered with AddGeometryColumn() rather than declared inline.' }],
    functions: [{ name: 'AddGeometryColumn', example: "AddGeometryColumn('places', 'geom', 4326, 'POINT', 2)" }],
  },
  {
    name: 'sqlite-vec',
    dialect: 'sqlite',
    label: 'sqlite-vec',
    summary: 'Vector search for SQLite: the small-scale counterpart to pgvector.',
    docsUrl: 'https://github.com/asg017/sqlite-vec',
    install: 'client-loaded',
    functions: [
      { name: 'vec_distance_l2', example: 'vec_distance_l2(a, b)' },
      { name: 'vec_distance_cosine', example: 'vec_distance_cosine(a, b)' },
    ],
    note: 'Vectors live in a vec0 virtual table; an ordinary column holds them as a BLOB.',
  },
];

/* ------------------------------------------------------------------ */
/* DuckDB                                                              */
/* ------------------------------------------------------------------ */

/**
 * DuckDB extensions are fetched from its extension repository with INSTALL and
 * activated per session with LOAD, both plain SQL, so they belong in a schema
 * script the way PostgreSQL's CREATE EXTENSION does. Several are bundled into
 * the native builds and load themselves the first time something needs them;
 * the in-browser engine fetches every one of them from extensions.duckdb.org,
 * which is why the script still says LOAD.
 */
const DUCKDB_DOCS = 'https://duckdb.org/docs/stable/core_extensions';

const DUCKDB: ExtensionDef[] = [
  {
    name: 'json',
    dialect: 'duckdb',
    label: 'JSON',
    summary: 'The JSON type and its functions. Bundled with native DuckDB and loaded on first use; the browser engine fetches it.',
    docsUrl: `${DUCKDB_DOCS}/json`,
    types: [{ name: 'JSON', summary: 'JSON text, validated on the way in and queryable with json_extract().' }],
    functions: [
      { name: 'json_extract', example: "json_extract(payload, '$.id')", summary: 'The value at a path, still as JSON.' },
      { name: 'json_extract_string', example: "json_extract_string(payload, '$.name')", summary: 'The value at a path, as text.' },
      { name: 'json_object', example: "json_object('id', id, 'name', name)" },
      { name: 'json_array', example: 'json_array(a, b)' },
      { name: 'json_valid', example: 'json_valid(payload)' },
    ],
  },
  {
    name: 'parquet',
    dialect: 'duckdb',
    label: 'Parquet',
    summary: 'Read and write Parquet files: read_parquet() as a table, COPY ... TO ... (FORMAT PARQUET) to write.',
    docsUrl: 'https://duckdb.org/docs/stable/data/parquet/overview',
    functions: [
      { name: 'read_parquet', example: "read_parquet('events/*.parquet')", summary: 'A file or glob as a table; the schema comes from the file.' },
      { name: 'parquet_schema', example: "parquet_schema('events.parquet')" },
      { name: 'parquet_metadata', example: "parquet_metadata('events.parquet')" },
    ],
    note: 'Bundled with native DuckDB. A file read this way is another data source: model it as an external group if the diagram should show where rows come from.',
  },
  {
    name: 'icu',
    dialect: 'duckdb',
    label: 'ICU',
    summary: 'Time zones and language-aware collations. Without it TIMESTAMPTZ arithmetic and COLLATE de / fr and the like are unavailable.',
    docsUrl: `${DUCKDB_DOCS}/icu`,
    functions: [
      { name: 'timezone', example: "timezone('Europe/Berlin', placed_at)", summary: 'A timestamp moved into a named zone.' },
      { name: 'icu_sort_key', example: "icu_sort_key(name, 'de')" },
    ],
    note: 'Bundled with native DuckDB and loaded on demand. The TIMESTAMPTZ type itself needs nothing; converting it between zones does.',
  },
  {
    name: 'spatial',
    dialect: 'duckdb',
    label: 'Spatial',
    summary: 'Geometry types, ST_ functions and an R-tree index: the PostGIS of DuckDB.',
    docsUrl: `${DUCKDB_DOCS}/spatial/overview`,
    types: [
      { name: 'GEOMETRY', summary: 'Any shape: a point, a line, a polygon, or a collection of them.' },
      { name: 'POINT_2D', summary: 'A fixed-layout point, faster than GEOMETRY when every row is a point.' },
      { name: 'LINESTRING_2D' },
      { name: 'POLYGON_2D' },
      { name: 'BOX_2D', summary: 'A 2D bounding box.' },
    ],
    functions: [
      { name: 'ST_Point', example: 'ST_Point(lon, lat)' },
      { name: 'ST_GeomFromText', example: "ST_GeomFromText('POINT(0 0)')" },
      { name: 'ST_AsText', example: 'ST_AsText(geom)' },
      { name: 'ST_Distance', example: 'ST_Distance(a, b)' },
      { name: 'ST_Within', example: 'ST_Within(a, b)' },
      { name: 'ST_Intersects', example: 'ST_Intersects(a, b)' },
      { name: 'ST_Read', example: "ST_Read('places.geojson')", summary: 'Any GDAL-readable file (GeoJSON, Shapefile, GeoPackage) as a table.' },
    ],
    indexMethods: ['rtree'],
    note: 'An R-tree index is CREATE INDEX ... USING RTREE (geom) and speeds up ST_Within / ST_Intersects filters. Coordinates carry no SRID: ST_Transform converts between reference systems explicitly.',
  },
  {
    name: 'vss',
    dialect: 'duckdb',
    label: 'Vector similarity search',
    summary: 'HNSW indexes over fixed-size FLOAT[n] arrays, so a nearest-neighbour ORDER BY ... LIMIT stops scanning the whole table.',
    docsUrl: `${DUCKDB_DOCS}/vss`,
    functions: [
      { name: 'array_distance', example: 'array_distance(embedding, query)', summary: 'Euclidean distance; what an HNSW index built with metric l2sq accelerates.' },
      { name: 'array_cosine_distance', example: 'array_cosine_distance(embedding, query)' },
      { name: 'array_inner_product', example: 'array_inner_product(embedding, query)' },
    ],
    indexMethods: ['hnsw'],
    note: "Embeddings are FLOAT[1536]-style arrays, not lists: the size is part of the type. Persisting an HNSW index in a database file needs SET hnsw_enable_experimental_persistence = true, and the index must be built with the metric the query uses.",
  },
  {
    name: 'fts',
    dialect: 'duckdb',
    label: 'Full-text search',
    summary: 'A BM25 full-text index over one or more text columns of a table.',
    docsUrl: `${DUCKDB_DOCS}/full_text_search`,
    functions: [
      { name: 'create_fts_index', example: "PRAGMA create_fts_index('docs', 'id', 'title', 'body')", summary: 'Builds the index once; rebuild it after the table changes.' },
      { name: 'match_bm25', example: "fts_main_docs.match_bm25(id, 'search words')", summary: 'The relevance score, or NULL for rows that do not match.' },
    ],
    note: 'The index lives in a schema named fts_main_<table> and is not kept up to date by inserts: drop and recreate it when the rows change.',
  },
  {
    name: 'inet',
    dialect: 'duckdb',
    label: 'inet',
    summary: 'The INET type for IPv4 and IPv6 addresses and networks, with containment operators.',
    docsUrl: `${DUCKDB_DOCS}/inet`,
    types: [{ name: 'INET', summary: 'An address with an optional prefix length, e.g. 10.0.0.0/8.' }],
    functions: [
      { name: 'host', example: 'host(address)', summary: 'The address without its prefix length.' },
      { name: 'netmask', example: 'netmask(address)' },
      { name: 'network', example: 'network(address)' },
      { name: 'family', example: 'family(address)', summary: '4 or 6.' },
    ],
  },
  {
    name: 'httpfs',
    dialect: 'duckdb',
    label: 'httpfs',
    summary: 'Read files straight from HTTP(S) and S3 URLs: read_parquet(\'https://...\') and read_csv(\'s3://...\').',
    docsUrl: `${DUCKDB_DOCS}/httpfs/overview`,
    note: 'Adds no types. S3 credentials go into a secret (CREATE SECRET), which the aws extension can fill from the environment.',
  },
  {
    name: 'aws',
    dialect: 'duckdb',
    label: 'AWS',
    summary: 'Loads S3 credentials from the AWS SDK chain (profiles, environment, instance roles) into a DuckDB secret.',
    docsUrl: `${DUCKDB_DOCS}/aws`,
    requires: ['httpfs'],
  },
  {
    name: 'azure',
    dialect: 'duckdb',
    label: 'Azure',
    summary: 'Read files from Azure Blob Storage and Data Lake through az:// and abfss:// URLs.',
    docsUrl: `${DUCKDB_DOCS}/azure`,
  },
  {
    name: 'sqlite_scanner',
    dialect: 'duckdb',
    label: 'SQLite scanner',
    summary: "Attach a SQLite file and query its tables in place: ATTACH 'app.db' (TYPE sqlite). Also answers to the name sqlite.",
    docsUrl: `${DUCKDB_DOCS}/sqlite`,
    note: 'The attached tables belong to the SQLite file. Put them in an external group so the diagram shows them as a source rather than creating them.',
  },
  {
    name: 'postgres_scanner',
    dialect: 'duckdb',
    label: 'PostgreSQL scanner',
    summary: "Attach a running PostgreSQL database and query it from DuckDB: ATTACH 'dbname=app' AS pg (TYPE postgres). Also answers to the name postgres.",
    docsUrl: `${DUCKDB_DOCS}/postgres`,
    note: 'Reads go to the PostgreSQL server; the tables are its. An external group fits them.',
  },
  {
    name: 'mysql_scanner',
    dialect: 'duckdb',
    label: 'MySQL scanner',
    summary: "Attach a MySQL or MariaDB database: ATTACH 'host=localhost user=root db=app' AS m (TYPE mysql). Also answers to the name mysql.",
    docsUrl: `${DUCKDB_DOCS}/mysql`,
  },
  {
    name: 'excel',
    dialect: 'duckdb',
    label: 'Excel',
    summary: 'read_xlsx() to read a spreadsheet as a table, COPY ... TO ... (FORMAT xlsx) to write one.',
    docsUrl: `${DUCKDB_DOCS}/excel`,
    functions: [{ name: 'read_xlsx', example: "read_xlsx('report.xlsx', sheet = 'Data')" }],
  },
  {
    name: 'delta',
    dialect: 'duckdb',
    label: 'Delta Lake',
    summary: 'Read Delta Lake tables with delta_scan().',
    docsUrl: `${DUCKDB_DOCS}/delta`,
    functions: [{ name: 'delta_scan', example: "delta_scan('s3://bucket/table')" }],
    requires: ['httpfs'],
  },
  {
    name: 'iceberg',
    dialect: 'duckdb',
    label: 'Iceberg',
    summary: 'Read Apache Iceberg tables with iceberg_scan(), or attach an Iceberg REST catalog.',
    docsUrl: `${DUCKDB_DOCS}/iceberg/overview`,
    functions: [{ name: 'iceberg_scan', example: "iceberg_scan('s3://bucket/table')" }],
    requires: ['httpfs'],
  },
  {
    name: 'ducklake',
    dialect: 'duckdb',
    label: 'DuckLake',
    summary: "A lakehouse format: Parquet data files with the catalog in a SQL database. ATTACH 'ducklake:catalog.ducklake' AS lake.",
    docsUrl: 'https://ducklake.select/docs/stable/',
    note: 'The attached catalog is another database. Tables you only read from it belong in an external group.',
  },
  {
    name: 'avro',
    dialect: 'duckdb',
    label: 'Avro',
    summary: 'Read Apache Avro files with read_avro().',
    docsUrl: `${DUCKDB_DOCS}/avro`,
    functions: [{ name: 'read_avro', example: "read_avro('events.avro')" }],
  },
  {
    name: 'encodings',
    dialect: 'duckdb',
    label: 'Encodings',
    summary: 'Extra text encodings (Shift_JIS, Windows-1252 and the rest of the ICU set) for reading CSV files that are not UTF-8.',
    docsUrl: `${DUCKDB_DOCS}/encodings`,
  },
  {
    name: 'tpch',
    dialect: 'duckdb',
    label: 'TPC-H',
    summary: 'Generates the TPC-H benchmark tables at a chosen scale factor: CALL dbgen(sf = 1).',
    docsUrl: `${DUCKDB_DOCS}/tpch`,
    functions: [{ name: 'dbgen', example: 'CALL dbgen(sf = 1)' }],
    note: 'Handy for a realistic eight-table schema to draw and query; the tables it creates can be pulled into the diagram with Read schema.',
  },
  {
    name: 'ui',
    dialect: 'duckdb',
    label: 'UI',
    summary: 'A local web interface for a native DuckDB session: CALL start_ui().',
    docsUrl: `${DUCKDB_DOCS}/ui`,
    functions: [{ name: 'start_ui', example: 'CALL start_ui()' }],
    note: 'For the DuckDB CLI and clients; it does nothing inside this app, which is already a UI over the same engine.',
  },
  {
    name: 'core_functions',
    dialect: 'duckdb',
    label: 'Core functions',
    summary: 'The standard function library. Statically linked into every build, including the in-browser one.',
    docsUrl: 'https://duckdb.org/docs/stable/sql/functions/overview',
    install: 'built-in',
    note: 'Listing it is harmless but never necessary.',
  },
];

/** Every definition the app ships with, tagged as bundled. */
export const BUNDLED_EXTENSIONS: ExtensionDef[] = [...POSTGRES, ...MARIADB, ...SQLITE, ...DUCKDB].map((e) => ({ ...e, source: 'bundled' as const }));
