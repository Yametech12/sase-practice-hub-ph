/**
 * In-memory fake for the @neondatabase/serverless `neon()` client.
 *
 * Quacks like the real driver for exactly the statements api/_exam-lib.js
 * issues (matched by their /* NEON:*\/ marker comments):
 *  - tag call `sql`...`` returns a LAZY query object (like the real driver:
 *    nothing executes until awaited or passed to transaction()).
 *  - `sql.transaction([...queries], opts)` executes them in order and returns
 *    one result array per query. The guard statement throws on snapshot
 *    mismatch (simulating the SQL 1/0 raise), which is what makes
 *    updateState's retry path testable.
 *  - `sql.query(text, params)` returns a lazy query (used by the migration
 *    script; not exercised by the lib tests).
 *
 * Test hooks:
 *  - mock.db — { bindings: Map, exams: Map("order:exam_n" -> data), subs: Map }
 *  - mock.writeCount — number of write statements executed (guard/locks/reads excluded)
 *  - mock.interfereOnce(fn) — runs fn against mock.db right before the next
 *    guard evaluation, simulating a concurrent writer between the lib's read
 *    and write phases.
 */

function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}

// Deep-clone: the real Neon driver returns fresh JSON-parsed objects per
// query (wire semantics) — the lib's in-memory state must NEVER alias the
// mock's stored rows, or a rolled-back mutator would leak into the DB.
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function createMockNeon() {
  const db = {
    bindings: new Map(), // order_id -> devices array
    exams: new Map(), // "order:exam_n" -> data
    subs: new Map(), // key -> result
  };
  let writeCount = 0;
  let interfereOnce = null;

  function exec(strings, values) {
    const text = strings.join("\u0000");
    const has = (m) => text.includes(m);

    if (has("NEON:read-bindings")) {
      return [...db.bindings.entries()].map(([order_id, devices]) => ({ order_id, devices: clone(devices) }));
    }
    if (has("NEON:read-exams")) {
      return [...db.exams.entries()].map(([k, data]) => {
        const i = k.lastIndexOf(":");
        return { order_id: k.slice(0, i), exam_n: Number(k.slice(i + 1)), data: clone(data) };
      });
    }
    if (has("NEON:read-subs")) {
      return [...db.subs.entries()].map(([key, result]) => ({ key, result: clone(result) }));
    }
    if (has("NEON:lock-")) return [];

    if (has("NEON:guard")) {
      if (interfereOnce) {
        const fn = interfereOnce;
        interfereOnce = null;
        fn(db);
      }
      const [b0, e0, s0] = values.map((v) => JSON.parse(v));
      // Every DB row must match the snapshot; every snapshot key must exist.
      for (const [order_id, devices] of db.bindings) {
        if (!(order_id in b0) || canon(devices) !== canon(b0[order_id].devices)) {
          throw new Error("NEON guard mismatch (concurrent change)");
        }
      }
      for (const order_id of Object.keys(b0)) {
        if (!db.bindings.has(order_id)) throw new Error("NEON guard mismatch (concurrent change)");
      }
      for (const [k, data] of db.exams) {
        const [order_id, n] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)];
        const exp = e0[order_id]?.[n];
        if (exp === undefined || canon(data) !== canon(exp)) {
          throw new Error("NEON guard mismatch (concurrent change)");
        }
      }
      for (const [order_id, orderExams] of Object.entries(e0)) {
        for (const n of Object.keys(orderExams)) {
          if (!db.exams.has(`${order_id}:${n}`)) {
            throw new Error("NEON guard mismatch (concurrent change)");
          }
        }
      }
      for (const [key, result] of db.subs) {
        if (!(key in s0) || canon(result) !== canon(s0[key])) {
          throw new Error("NEON guard mismatch (concurrent change)");
        }
      }
      for (const key of Object.keys(s0)) {
        if (!db.subs.has(key)) throw new Error("NEON guard mismatch (concurrent change)");
      }
      return [{ "?column?": 1 }];
    }

    if (has("NEON:write-bindings") && !has("-del")) {
      writeCount++;
      const after = JSON.parse(values[0]);
      for (const [order_id, rec] of Object.entries(after)) db.bindings.set(order_id, clone(rec.devices));
      return [];
    }
    if (has("NEON:write-bindings-del")) {
      const after = JSON.parse(values[0]);
      for (const order_id of [...db.bindings.keys()]) {
        if (!(order_id in after)) db.bindings.delete(order_id);
      }
      return [];
    }
    if (has("NEON:write-exams") && !has("-del")) {
      writeCount++;
      const after = JSON.parse(values[0]);
      for (const [order_id, orderExams] of Object.entries(after)) {
        for (const [n, rec] of Object.entries(orderExams)) db.exams.set(`${order_id}:${n}`, clone(rec));
      }
      return [];
    }
    if (has("NEON:write-exams-del")) {
      const after = JSON.parse(values[0]);
      for (const k of [...db.exams.keys()]) {
        const [order_id, n] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)];
        if (!after[order_id]?.[n]) db.exams.delete(k);
      }
      return [];
    }
    if (has("NEON:write-subs") && !has("-del")) {
      writeCount++;
      const after = JSON.parse(values[0]);
      for (const [key, entry] of Object.entries(after)) db.subs.set(key, clone(entry));
      return [];
    }
    if (has("NEON:write-subs-del")) {
      const after = JSON.parse(values[0]);
      for (const key of [...db.subs.keys()]) {
        if (!(key in after)) db.subs.delete(key);
      }
      return [];
    }
    throw new Error(`mock-neon: unrecognized query: ${text.slice(0, 120)}`);
  }

  function tag(strings, ...values) {
    // Lazy query object: executes only when awaited or run via transaction().
    const q = { __strings: strings, __values: values };
    q.then = (resolve, reject) => {
      try {
        resolve(exec(strings, values));
      } catch (e) {
        reject(e);
      }
    };
    return q;
  }
  tag.transaction = async (queries, _opts) => {
    const results = [];
    for (const q of queries) results.push(exec(q.__strings, q.__values));
    return results;
  };
  tag.query = (text, params = []) => {
    const strings = [text];
    strings.raw = [text];
    return tag(strings, ...params);
  };

  tag.db = db;
  tag.interfereOnce = (fn) => {
    interfereOnce = fn;
  };
  Object.defineProperty(tag, "writeCount", { get: () => writeCount });
  return tag;
}
