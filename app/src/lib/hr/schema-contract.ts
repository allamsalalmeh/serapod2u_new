/**
 * HR database column contract (B2B). Test-support module: compares the column names that HR code writes, filters on
 * and selects through the Supabase query builder with the committed schema snapshot plus every later migration.
 * Static analysis only (TypeScript AST); no database connection.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export type Usage = { file: string; line: number; table: string; column: string; kind: string }

/** Columns of public.hr_* tables from a pg_dump schema file. */
export function parseSchemaColumns(sql: string, into = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const tableRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?(hr_[a-z0-9_]+)"? \(([\s\S]*?)\n\);/gi
  for (const m of sql.matchAll(tableRe)) {
    const cols = into.get(m[1]) ?? new Set<string>()
    for (const raw of m[2].split('\n')) {
      const line = raw.trim()
      if (!line || /^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE|--)/i.test(line)) continue
      const name = line.match(/^"?([a-z_][a-z0-9_]*)"?\s/i)
      if (name) cols.add(name[1].toLowerCase())
    }
    into.set(m[1], cols)
  }
  return into
}

/** Columns added by migrations newer than the snapshot (create table / add column). */
export function parseMigrationColumns(sql: string, into: Map<string, Set<string>>): void {
  parseSchemaColumns(sql.replace(/create table/gi, 'CREATE TABLE').replace(/\n\s*\)\s*;/g, '\n);'), into)
  const addRe = /alter table (?:only )?(?:if exists )?(?:public\.)?(hr_[a-z0-9_]+)([\s\S]*?);/gi
  for (const m of sql.matchAll(addRe)) {
    const cols = into.get(m[1]) ?? new Set<string>()
    for (const c of m[2].matchAll(/add column (?:if not exists )?"?([a-z_][a-z0-9_]*)"?/gi)) cols.add(c[1].toLowerCase())
    into.set(m[1], cols)
  }
}

export function loadHrSchema(repoRoot: string, snapshot = 'supabase/schemas/audit/staging_schema_20261016.sql', after = '20261016'): Map<string, Set<string>> {
  const schema = parseSchemaColumns(fs.readFileSync(path.join(repoRoot, snapshot), 'utf8'))
  const dir = path.join(repoRoot, 'supabase/migrations')
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f.slice(0, 8) > after).sort()) {
    parseMigrationColumns(fs.readFileSync(path.join(dir, f), 'utf8'), schema)
  }
  return schema
}

const WRITE = new Set(['insert', 'update', 'upsert'])
const FILTER = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike', 'contains', 'order', 'not'])

function plainSelectColumns(text: string): string[] {
  // Only top-level, unaliased, plain column names; embedded resources, casts, aliases and * are skipped.
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => /^[a-z_][a-z0-9_]*$/.test(s))
}

/** Every literal column usage on `.from('hr_*')` chains in one source file. */
export function scanSource(file: string, source: string): Usage[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const usages: Usage[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'from'
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.startsWith('hr_')) {
      const table = node.arguments[0].text
      // walk up the method chain: from(...).x(...).y(...)
      let cur: ts.Node = node
      while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.parent && ts.isCallExpression(cur.parent.parent)) {
        const method = cur.parent.name.text
        const call = cur.parent.parent
        const arg = call.arguments[0]
        if (WRITE.has(method) && arg) {
          const objects = ts.isArrayLiteralExpression(arg) ? arg.elements : [arg]
          for (const o of objects) {
            if (!ts.isObjectLiteralExpression(o)) continue
            for (const p of o.properties) {
              if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
                usages.push({ file, line: lineOf(p), table, column: p.name.text, kind: method })
              }
            }
          }
        } else if (FILTER.has(method) && arg && ts.isStringLiteralLike(arg) && /^[a-z_][a-z0-9_]*$/.test(arg.text)) {
          usages.push({ file, line: lineOf(arg), table, column: arg.text, kind: method })
        } else if (method === 'select' && arg && ts.isStringLiteralLike(arg)) {
          for (const c of plainSelectColumns(arg.text)) usages.push({ file, line: lineOf(arg), table, column: c, kind: 'select' })
        }
        cur = call
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return usages
}

export function listSourceFiles(dirs: string[]): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return
    const st = fs.statSync(d)
    if (st.isFile()) { if (/\.tsx?$/.test(d) && !/\.test\.tsx?$/.test(d)) out.push(d); return }
    for (const e of fs.readdirSync(d)) walk(path.join(d, e))
  }
  dirs.forEach(walk)
  return out.sort()
}

export function findViolations(schema: Map<string, Set<string>>, usages: Usage[]): Usage[] {
  return usages.filter((u) => {
    const cols = schema.get(u.table)
    return cols !== undefined && !cols.has(u.column)
  })
}

export function findUnknownTables(schema: Map<string, Set<string>>, usages: Usage[]): string[] {
  return [...new Set(usages.filter((u) => !schema.has(u.table)).map((u) => u.table))].sort()
}
