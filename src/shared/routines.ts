/**
 * Reading a routine's parameter list, shared by the DDL parser in the browser
 * and the server's catalog queries: PostgreSQL's pg_get_function_arguments()
 * hands back the same text a CREATE statement has between its parentheses, so
 * both sides read it with the one function.
 */
import type { ProcedureParamMode } from './types';

export interface RoutineParamText {
  name: string;
  type: string;
  mode?: ProcedureParamMode;
  defaultValue?: string;
}

/** Types spelled in two words, which a "name type" split would otherwise read as a parameter called DOUBLE. */
const MULTIWORD_TYPE = /^(DOUBLE\s+PRECISION|CHARACTER\s+VARYING|BIT\s+VARYING|TIME(STAMP)?\s+WITH(OUT)?\s+TIME\s+ZONE)\b/i;

/**
 * "IN p_id int, OUT total numeric DEFAULT 0" -> parameters.
 *
 * `foldCase` lower-cases unquoted names, which is what PostgreSQL does to them.
 * A parameter written without a name (PostgreSQL allows `(integer, text)`) is
 * called arg1, arg2, … after its position, so it can still be shown and edited.
 */
export function parseRoutineParams(raw: string, foldCase: boolean): RoutineParamText[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of raw) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((part, i) => {
    let text = part.trim();
    let mode: ProcedureParamMode | undefined;
    const m = /^(IN\s+OUT|INOUT|IN|OUT|VARIADIC)\s+/i.exec(text);
    if (m) {
      const w = m[1].replace(/\s+/g, '').toUpperCase();
      mode = w === 'OUT' ? 'out' : w === 'INOUT' ? 'inout' : undefined;
      text = text.slice(m[0].length);
    }
    let defaultValue: string | undefined;
    const d = /\s+DEFAULT\s+|\s*=\s*/i.exec(text);
    if (d) {
      defaultValue = text.slice(d.index + d[0].length).trim();
      text = text.slice(0, d.index).trim();
    }
    let name = '';
    let type = text;
    const sp = /^("(?:[^"]|"")+"|`(?:[^`]|``)+`|[^\s(]+)\s+([\s\S]+)$/.exec(text);
    if (sp && !MULTIWORD_TYPE.test(text)) {
      const quoted = /^["`]/.test(sp[1]);
      name = quoted ? sp[1].slice(1, -1) : sp[1];
      if (!quoted && foldCase) name = name.toLowerCase();
      type = sp[2].trim();
    }
    return { name: name || `arg${i + 1}`, type, ...(mode ? { mode } : {}), ...(defaultValue ? { defaultValue } : {}) };
  });
}
