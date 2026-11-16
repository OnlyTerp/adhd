// Recovers the JSON object a model was asked for when it arrives as prose-wrapped,
// fenced, or with LaTeX written into strings without escaping (\( \frac \theta).
const fence = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/;
// LaTeX commands whose first letter is also a JSON escape (\b \f \n \r \t).
const LATEX = new Set(['frac', 'tfrac', 'dfrac', 'beta', 'bar', 'binom', 'bmod', 'boxed', 'big', 'bigl', 'bigr', 'bot', 'bullet',
  'forall', 'flat', 'theta', 'times', 'text', 'textbf', 'textit', 'tau', 'to', 'top', 'tilde', 'triangle', 'tan', 'tanh',
  'rho', 'right', 'rangle', 'rfloor', 'rceil', 'rightarrow', 'neq', 'nabla', 'nu', 'not', 'neg', 'notin', 'nmid']);

// Doubles every backslash inside a JSON string that is not a valid JSON escape, or that
// starts a LaTeX command; escapes raw control characters inside strings.
export function repairEscapes(text) {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inString) { if (c === '"') inString = true; out += c; continue; }
    if (c === '"') { inString = false; out += c; continue; }
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') { out += '\\r'; continue; }
    if (c === '\t') { out += '\\t'; continue; }
    if (c !== '\\') { out += c; continue; }
    const next = text[i + 1] ?? '', word = /^[a-zA-Z]+/.exec(text.slice(i + 1))?.[0] ?? '';
    if (LATEX.has(word)) { out += '\\\\' + word; i += word.length; continue; }
    if ('"\\/bfnrt'.includes(next) && next) { out += c + next; i++; continue; }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += c + next; i++; continue; }
    out += '\\\\';
  }
  return out;
}

const object = v => v && typeof v === 'object' && !Array.isArray(v);
// Control characters a tracker never means to write: their presence means LaTeX was read as an escape.
const suspicious = v => typeof v === 'string' ? /[\b\f\t]/.test(v) : v !== null && typeof v === 'object' && Object.values(v).some(suspicious);

export function extractJson(text) {
  const s = String(text).trim(), m = fence.exec(s), tries = [m ? m[1].trim() : s], a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const x of tries) {
    let strict; try { strict = JSON.parse(x); } catch {}
    if (object(strict) && !suspicious(strict)) return strict;
    try { const v = JSON.parse(repairEscapes(x)); if (object(v)) return v; } catch {}
    if (object(strict)) return strict;
  }
  return null;
}
