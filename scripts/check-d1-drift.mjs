#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [dbName, configFile = 'wrangler.toml'] = process.argv.slice(2);
const wranglerBin = process.env.WRANGLER || 'wrangler';

if (!dbName) {
  console.error('Usage: node scripts/check-d1-drift.mjs <d1_database_name> [wrangler_config]');
  process.exit(1);
}

const schemaSql = readFileSync(new URL('../d1-init.sql', import.meta.url), 'utf8');
const expected = parseExpectedSchema(schemaSql);
const remote = await readRemoteSchema(dbName, configFile);
const drift = compareSchemas(expected, remote);

if (!remote.tables.size && !remote.indexes.size) {
  console.log('D1 drift check: database schema is empty; initialization can proceed.');
  process.exit(0);
}

if (drift.length) {
  console.error('DATABASE DRIFT DETECTED. Stop deployment immediately.');
  for (const item of drift) {
    console.error(`- ${item}`);
  }
  process.exit(2);
}

console.log('D1 drift check: remote schema matches d1-init.sql.');

function parseExpectedSchema(sql) {
  const tables = new Map();
  const indexes = new Map();

  const tablePattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
  for (const match of sql.matchAll(tablePattern)) {
    const tableName = match[1];
    const body = match[2];
    const columns = [];

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || /^(FOREIGN|UNIQUE|PRIMARY|CONSTRAINT|CHECK)\b/i.test(line)) continue;
      const columnMatch = line.match(/^([a-zA-Z0-9_]+)\b/);
      if (columnMatch) columns.push(columnMatch[1]);
    }

    tables.set(tableName, columns);
  }

  const indexPattern = /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z0-9_]+)\s+ON\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
  for (const match of sql.matchAll(indexPattern)) {
    indexes.set(match[1], {
      table: match[2],
      columns: normalizeIndexColumns(match[3]),
    });
  }

  return { tables, indexes };
}

async function readRemoteSchema(databaseName, configPath) {
  const rows = await queryD1(databaseName, configPath, `
    SELECT name, type, tbl_name
    FROM sqlite_schema
    WHERE type IN ('table', 'index')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
    ORDER BY type, name
  `);

  const remoteTables = new Map();
  const remoteIndexes = new Map();

  for (const row of rows) {
    if (row.type === 'table') {
      const columns = await queryD1(databaseName, configPath, `PRAGMA table_info(${quoteIdentifier(row.name)})`);
      remoteTables.set(row.name, columns.map((column) => column.name));
    }

    if (row.type === 'index') {
      const columns = await queryD1(databaseName, configPath, `PRAGMA index_info(${quoteIdentifier(row.name)})`);
      remoteIndexes.set(row.name, {
        table: row.tbl_name,
        columns: columns.map((column) => column.name),
      });
    }
  }

  return { tables: remoteTables, indexes: remoteIndexes };
}

async function queryD1(databaseName, configPath, command) {
  const output = execFileSync(
    wranglerBin,
    ['d1', 'execute', databaseName, '-c', configPath, '--remote', '--json', '--command', command],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const parsed = JSON.parse(output);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  return result?.results || result?.result?.[0]?.results || [];
}

function compareSchemas(expectedSchema, remoteSchema) {
  const problems = [];

  for (const [table, expectedColumns] of expectedSchema.tables) {
    const remoteColumns = remoteSchema.tables.get(table);
    if (!remoteColumns) {
      problems.push(`missing table: ${table}`);
      continue;
    }

    const expectedSet = new Set(expectedColumns);
    const remoteSet = new Set(remoteColumns);

    for (const column of expectedColumns) {
      if (!remoteSet.has(column)) problems.push(`missing column: ${table}.${column}`);
    }

    for (const column of remoteColumns) {
      if (!expectedSet.has(column)) problems.push(`unexpected column: ${table}.${column}`);
    }
  }

  for (const table of remoteSchema.tables.keys()) {
    if (!expectedSchema.tables.has(table)) problems.push(`unexpected table: ${table}`);
  }

  for (const [index, expectedIndex] of expectedSchema.indexes) {
    const remoteIndex = remoteSchema.indexes.get(index);
    if (!remoteIndex) {
      problems.push(`missing index: ${index}`);
      continue;
    }

    if (remoteIndex.table !== expectedIndex.table) {
      problems.push(`index table mismatch: ${index} expected ${expectedIndex.table}, got ${remoteIndex.table}`);
    }

    const expectedColumns = expectedIndex.columns.join(',');
    const remoteColumns = remoteIndex.columns.join(',');
    if (remoteColumns !== expectedColumns) {
      problems.push(`index columns mismatch: ${index} expected (${expectedColumns}), got (${remoteColumns})`);
    }
  }

  for (const index of remoteSchema.indexes.keys()) {
    if (!expectedSchema.indexes.has(index)) problems.push(`unexpected index: ${index}`);
  }

  return problems;
}

function normalizeIndexColumns(value) {
  return value
    .split(',')
    .map((column) => column.trim().replace(/\s+DESC$/i, '').replace(/\s+ASC$/i, ''))
    .filter(Boolean);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
