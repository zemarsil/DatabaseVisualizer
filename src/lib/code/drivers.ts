/**
 * How each language reaches each engine.
 *
 * The generated starter is only worth having if it names the driver a reader
 * would actually reach for and binds parameters the way that driver expects, so
 * that is exactly what this table holds and nothing more: the package, the line
 * that installs it, what it imports, how it connects, and how it spells the nth
 * parameter. Everything else about the generated file is the language's shape,
 * which lives in generate.ts.
 *
 * A pairing that is missing here is not an error. It means "no template for
 * this combination", and the generator falls back to a commented skeleton with
 * the same SQL in it, which is still useful and never pretends to compile.
 */
import type { Dialect, ProgramLanguage } from '@shared/types';

/**
 * Which client-side shape the generated file takes.
 *
 * The package is not enough to write code with: sqlx and duckdb-rs are both
 * Rust and share nothing, and node-postgres, node:sqlite and DuckDB's Node API
 * disagree about what running a statement even returns. So each pairing names
 * its shape, and the emitter writes that shape's calls.
 */
export type DriverShape =
  | 'psycopg' | 'mariadb-py' | 'sqlite3-py' | 'duckdb-py'
  | 'sqlx' | 'duckdb-rs'
  | 'database-sql'
  | 'jdbc'
  | 'pg' | 'mariadb-node' | 'node-sqlite' | 'duckdb-node'
  | 'libpq' | 'mysql-c' | 'sqlite3-c' | 'duckdb-c'
  | 'libpqxx' | 'mariadb-cpp' | 'sqlitecpp' | 'duckdb-cpp';

export interface Driver {
  /** The package as a reader would search for it. */
  label: string;
  /** One line that gets it. */
  install: string;
  /** Import, use, include or require lines, already written in the language. */
  imports: string[];
  /** Expression or statement that produces a live connection. */
  connect: string;
  /** Connection string the generated file starts from. */
  dsn: string;
  /** The nth (1-based) bound parameter, as this driver spells it. */
  placeholder: (n: number) => string;
  /** Which set of calls the emitter writes around the SQL. */
  shape: DriverShape;
}

const numbered = (n: number) => `$${n}`;
const question = () => '?';
const percentS = () => '%s';

type Table = Partial<Record<Dialect, Driver>>;

const PYTHON: Table = {
  postgresql: {
    label: 'psycopg 3',
    install: 'pip install "psycopg[binary]"',
    imports: ['import os', 'import psycopg'],
    connect: 'psycopg.connect(DSN)',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: percentS,
    shape: 'psycopg',
  },
  mariadb: {
    label: 'MariaDB Connector/Python',
    install: 'pip install mariadb',
    imports: ['import os', 'import mariadb'],
    connect: 'mariadb.connect(host="localhost", port=3306, user="root", database=DSN)',
    dsn: 'mysql',
    placeholder: question,
    shape: 'mariadb-py',
  },
  sqlite: {
    label: 'sqlite3 (standard library)',
    install: 'nothing to install: sqlite3 ships with Python',
    imports: ['import os', 'import sqlite3'],
    connect: 'sqlite3.connect(DSN)',
    dsn: './database.db',
    placeholder: question,
    shape: 'sqlite3-py',
  },
  duckdb: {
    label: 'duckdb',
    install: 'pip install duckdb',
    imports: ['import os', 'import duckdb'],
    connect: 'duckdb.connect(DSN)',
    dsn: './database.duckdb',
    placeholder: question,
    shape: 'duckdb-py',
  },
};

const RUST: Table = {
  postgresql: {
    label: 'sqlx (postgres, tokio)',
    install: 'cargo add sqlx --features runtime-tokio,postgres && cargo add tokio --features full',
    imports: ['use sqlx::postgres::PgPoolOptions;', 'use sqlx::Row;'],
    connect: 'PgPoolOptions::new().max_connections(5).connect(&dsn).await?',
    shape: 'sqlx',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: numbered,
  },
  mariadb: {
    label: 'sqlx (mysql, tokio)',
    install: 'cargo add sqlx --features runtime-tokio,mysql && cargo add tokio --features full',
    imports: ['use sqlx::mysql::MySqlPoolOptions;', 'use sqlx::Row;'],
    connect: 'MySqlPoolOptions::new().max_connections(5).connect(&dsn).await?',
    shape: 'sqlx',
    dsn: 'mysql://root@localhost:3306/mysql',
    placeholder: question,
  },
  sqlite: {
    label: 'sqlx (sqlite, tokio)',
    install: 'cargo add sqlx --features runtime-tokio,sqlite && cargo add tokio --features full',
    imports: ['use sqlx::sqlite::SqlitePoolOptions;', 'use sqlx::Row;'],
    connect: 'SqlitePoolOptions::new().connect(&dsn).await?',
    shape: 'sqlx',
    dsn: 'sqlite://database.db',
    placeholder: question,
  },
  duckdb: {
    label: 'duckdb',
    install: 'cargo add duckdb --features bundled',
    imports: ['use duckdb::{params, Connection};'],
    connect: 'Connection::open(&dsn)?',
    dsn: './database.duckdb',
    placeholder: question,
    shape: 'duckdb-rs',
  },
};

const GO: Table = {
  postgresql: {
    label: 'pgx (through database/sql)',
    install: 'go get github.com/jackc/pgx/v5',
    imports: ['"database/sql"', '_ "github.com/jackc/pgx/v5/stdlib"'],
    connect: 'sql.Open("pgx", dsn)',
    shape: 'database-sql',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: numbered,
  },
  mariadb: {
    label: 'go-sql-driver/mysql',
    install: 'go get github.com/go-sql-driver/mysql',
    imports: ['"database/sql"', '_ "github.com/go-sql-driver/mysql"'],
    connect: 'sql.Open("mysql", dsn)',
    shape: 'database-sql',
    dsn: 'root@tcp(localhost:3306)/mysql',
    placeholder: question,
  },
  sqlite: {
    label: 'modernc.org/sqlite (no cgo)',
    install: 'go get modernc.org/sqlite',
    imports: ['"database/sql"', '_ "modernc.org/sqlite"'],
    connect: 'sql.Open("sqlite", dsn)',
    shape: 'database-sql',
    dsn: './database.db',
    placeholder: question,
  },
  duckdb: {
    label: 'go-duckdb',
    install: 'go get github.com/marcboeker/go-duckdb',
    imports: ['"database/sql"', '_ "github.com/marcboeker/go-duckdb"'],
    connect: 'sql.Open("duckdb", dsn)',
    shape: 'database-sql',
    dsn: './database.duckdb',
    placeholder: question,
  },
};

const C: Table = {
  postgresql: {
    label: 'libpq',
    install: 'apt install libpq-dev / brew install libpq, then link with -lpq',
    imports: ['#include <libpq-fe.h>'],
    connect: 'PQconnectdb(dsn)',
    shape: 'libpq',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: numbered,
  },
  mariadb: {
    label: 'MariaDB Connector/C',
    install: 'apt install libmariadb-dev / brew install mariadb-connector-c, then link with -lmariadb',
    imports: ['#include <mysql.h>'],
    connect: 'mysql_real_connect(conn, "localhost", "root", "", "mysql", 3306, NULL, 0)',
    shape: 'mysql-c',
    dsn: 'mysql',
    placeholder: question,
  },
  sqlite: {
    label: 'SQLite amalgamation',
    install: 'apt install libsqlite3-dev / brew install sqlite, then link with -lsqlite3',
    imports: ['#include <sqlite3.h>'],
    connect: 'sqlite3_open(dsn, &db)',
    shape: 'sqlite3-c',
    dsn: './database.db',
    placeholder: question,
  },
  duckdb: {
    label: 'DuckDB C API',
    install: 'download libduckdb from duckdb.org, then link with -lduckdb',
    imports: ['#include <duckdb.h>'],
    connect: 'duckdb_open(dsn, &db)',
    shape: 'duckdb-c',
    dsn: './database.duckdb',
    placeholder: question,
  },
};

/**
 * C++ is not C with a different extension.
 *
 * Writing libpq into a .cpp file would compile, and would also be the wrong
 * advice: a C++ reader reaches for the library that owns its own handles and
 * throws on failure, because that is the half of the work the generated file
 * would otherwise be silently leaving to them.
 */
const CPP: Table = {
  postgresql: {
    label: 'libpqxx',
    install: 'apt install libpqxx-dev / brew install libpqxx, then link with -lpqxx -lpq',
    imports: ['#include <pqxx/pqxx>'],
    connect: 'pqxx::connection{dsn}',
    shape: 'libpqxx',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: numbered,
  },
  mariadb: {
    label: 'MariaDB Connector/C++',
    install: 'build mariadb-connector-cpp from mariadb.com, then link with -lmariadbcpp',
    imports: ['#include <mariadb/conncpp.hpp>'],
    connect: 'sql::mariadb::get_driver_instance()->connect(dsn, "root", "")',
    shape: 'mariadb-cpp',
    dsn: 'jdbc:mariadb://localhost:3306/mysql',
    placeholder: question,
  },
  sqlite: {
    label: 'SQLiteCpp',
    install: 'add SQLiteCpp with FetchContent or vcpkg, then link with SQLiteCpp sqlite3',
    imports: ['#include <SQLiteCpp/SQLiteCpp.h>'],
    connect: 'SQLite::Database{dsn, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE}',
    shape: 'sqlitecpp',
    dsn: './database.db',
    placeholder: question,
  },
  duckdb: {
    label: 'DuckDB C++ API',
    install: 'download libduckdb from duckdb.org, then link with -lduckdb',
    imports: ['#include <duckdb.hpp>'],
    connect: 'duckdb::DuckDB{dsn}',
    shape: 'duckdb-cpp',
    dsn: './database.duckdb',
    placeholder: question,
  },
};

const JAVA: Table = {
  postgresql: {
    label: 'PostgreSQL JDBC',
    install: 'org.postgresql:postgresql',
    imports: ['import java.sql.*;'],
    connect: 'DriverManager.getConnection(DSN)',
    shape: 'jdbc',
    dsn: 'jdbc:postgresql://localhost:5432/postgres?user=postgres',
    placeholder: question,
  },
  mariadb: {
    label: 'MariaDB JDBC',
    install: 'org.mariadb.jdbc:mariadb-java-client',
    imports: ['import java.sql.*;'],
    connect: 'DriverManager.getConnection(DSN)',
    shape: 'jdbc',
    dsn: 'jdbc:mariadb://localhost:3306/mysql?user=root',
    placeholder: question,
  },
  sqlite: {
    label: 'SQLite JDBC',
    install: 'org.xerial:sqlite-jdbc',
    imports: ['import java.sql.*;'],
    connect: 'DriverManager.getConnection(DSN)',
    shape: 'jdbc',
    dsn: 'jdbc:sqlite:database.db',
    placeholder: question,
  },
  duckdb: {
    label: 'DuckDB JDBC',
    install: 'org.duckdb:duckdb_jdbc',
    imports: ['import java.sql.*;'],
    connect: 'DriverManager.getConnection(DSN)',
    shape: 'jdbc',
    dsn: 'jdbc:duckdb:database.duckdb',
    placeholder: question,
  },
};

const NODE: Table = {
  postgresql: {
    label: 'node-postgres',
    install: 'npm install pg',
    imports: ["import pg from 'pg';"],
    connect: 'new pg.Pool({ connectionString: DSN })',
    shape: 'pg',
    dsn: 'postgresql://postgres@localhost:5432/postgres',
    placeholder: numbered,
  },
  mariadb: {
    label: 'mariadb (Node.js connector)',
    install: 'npm install mariadb',
    imports: ["import mariadb from 'mariadb';"],
    connect: "mariadb.createPool({ host: 'localhost', port: 3306, user: 'root', database: 'mysql' })",
    shape: 'mariadb-node',
    dsn: 'mysql',
    placeholder: question,
  },
  sqlite: {
    label: 'node:sqlite (Node 22+)',
    install: 'nothing to install: node:sqlite ships with Node 22 and newer',
    imports: ["import { DatabaseSync } from 'node:sqlite';"],
    connect: 'new DatabaseSync(DSN)',
    shape: 'node-sqlite',
    dsn: './database.db',
    placeholder: question,
  },
  duckdb: {
    label: '@duckdb/node-api',
    install: 'npm install @duckdb/node-api',
    imports: ["import { DuckDBInstance } from '@duckdb/node-api';"],
    connect: 'await (await DuckDBInstance.create(DSN)).connect()',
    shape: 'duckdb-node',
    dsn: './database.duckdb',
    placeholder: question,
  },
};

const DRIVERS: Partial<Record<ProgramLanguage, Table>> = {
  python: PYTHON,
  rust: RUST,
  go: GO,
  c: C,
  cpp: CPP,
  java: JAVA,
  javascript: NODE,
  typescript: NODE,
};

export function driverFor(language: ProgramLanguage, dialect: Dialect): Driver | undefined {
  return DRIVERS[language]?.[dialect];
}

/** Whether a real template exists for this pairing, as opposed to the commented fallback. */
export function hasDriver(language: ProgramLanguage, dialect: Dialect): boolean {
  return driverFor(language, dialect) !== undefined;
}
