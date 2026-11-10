/**
 * javaResolve.js — pass 2 of declared-type resolution for the Java analyzer.
 *
 * Walks every method, constructor and initializer body with a scope stack
 * (parameters, locals, for-each / catch / try-with-resources / lambda variables, and
 * class frames whose fields include inherited and outer ones) and gives every call
 * site a receiver type:
 *
 *   bare m(), this.m()        own class, project base classes, outer classes, static imports
 *   super.m()                 the base class chain above the own class
 *   x.m(), this.f.m(), x.f.m() declared type of the local, parameter or field
 *   Class.m(), pkg.Class.m()  the class itself
 *   a[i].m()                  the array's element type
 *   ((T) x).m()               the cast type
 *   a().b()                   the declared return type of the resolved a
 *   list.get(i).m()           element type of a generic java.util container (fixed table)
 *   new X(..), super(..), this(..)   the constructors of X, the base class, the own class
 *
 * With the type known, the method is looked up in that class and up its project
 * ancestors (the static target, as javac binds it). Overloads are chosen by argument
 * count, then by argument types where known; when several remain all are linked.
 * Non-project types give library edges keyed `library::<package>.<Class>::<method>`
 * (constructors `<init>`). A receiver whose type stays unknown gets no edge and is
 * recorded as `unknown-type`; there is no name-only guessing.
 *
 * Every call site's outcome is recorded (`sites`), for diagnostics and for the
 * export's call-site report.
 */
'use strict';

const T = require('./javaTypes.js');
const { kids, kid, isTok, startOf } = T;

const LIB_ELEMENT_METHODS = new Set(['get', 'remove', 'elementAt', 'firstElement', 'lastElement', 'peek', 'poll',
  'pop', 'next', 'previous', 'getFirst', 'getLast', 'removeFirst', 'removeLast', 'pollFirst', 'pollLast',
  'peekFirst', 'peekLast', 'element', 'take', 'first', 'last', 'set', 'push', 'floor', 'ceiling', 'higher', 'lower']);
const MAP_VALUE_METHODS = new Set(['get', 'put', 'remove', 'getOrDefault', 'putIfAbsent', 'replace']);
/** Whether a library fqn is a java.util map type (values come from the second type argument). */
const isMapType = (fqn) => /(^|\.)(Map|HashMap|TreeMap|LinkedHashMap|Hashtable|SortedMap|NavigableMap|ConcurrentHashMap|WeakHashMap|IdentityHashMap|EnumMap|Dictionary)$/.test(fqn);
/** Whether a library fqn may be a generic container whose element type is its first type argument. */
const isContainerType = (fqn) => fqn.startsWith('java.util.');

const STRING = { k: 'l', fqn: 'java.lang.String', args: [], dims: 0 };
/** Primitive type value ('int', 'boolean', 'null', ...), with optional array dims. */
const prim = (name, dims) => ({ k: 'p', name, dims: dims || 0 });
/** Library class type value by fully qualified name, with optional type arguments. */
const lib = (fqn, args) => ({ k: 'l', fqn, args: args || [], dims: 0 });

const STRING_RETURNS = {
  substring: STRING, trim: STRING, toLowerCase: STRING, toUpperCase: STRING, replace: STRING, replaceAll: STRING,
  replaceFirst: STRING, concat: STRING, toString: STRING, valueOf: STRING, format: STRING, intern: STRING, strip: STRING,
  repeat: STRING, length: prim('int'), indexOf: prim('int'), lastIndexOf: prim('int'), charAt: prim('char'),
  equals: prim('boolean'), equalsIgnoreCase: prim('boolean'), startsWith: prim('boolean'), endsWith: prim('boolean'),
  contains: prim('boolean'), isEmpty: prim('boolean'), compareTo: prim('int'), hashCode: prim('int'),
  split: { k: 'l', fqn: 'java.lang.String', args: [], dims: 1 }, toCharArray: prim('char', 1), getBytes: prim('byte', 1),
};
const BOXES = {
  'java.lang.Integer': 'int', 'java.lang.Long': 'long', 'java.lang.Short': 'short', 'java.lang.Byte': 'byte',
  'java.lang.Character': 'char', 'java.lang.Float': 'float', 'java.lang.Double': 'double', 'java.lang.Boolean': 'boolean',
};
const NUM_RANK = { byte: 1, short: 2, char: 2, int: 3, long: 4, float: 5, double: 6 };
const FINAL_LANG = new Set(['java.lang.String', 'java.lang.StringBuilder', 'java.lang.StringBuffer', 'java.lang.Math', 'java.lang.System', 'java.lang.Class']);
const OBJECT_METHODS = new Set(['toString', 'equals', 'hashCode', 'getClass', 'clone', 'finalize', 'wait', 'notify', 'notifyAll']);
const LIB_STATIC_FIELDS = { 'java.lang.System.out': lib('java.io.PrintStream'), 'java.lang.System.err': lib('java.io.PrintStream') };

/** Return type of a library method, as far as the fixed tables know it. */
function libReturn(recv, name, argTypes) {
  const fqn = recv.fqn; const a = recv.args || [];
  if (recv.dims) { return name === 'clone' ? recv : null; }
  if (name === 'toString') { return STRING; }
  if (name === 'hashCode') { return prim('int'); }
  if (name === 'equals') { return prim('boolean'); }
  if (name === 'getClass') { return lib('java.lang.Class'); }
  if (fqn === 'java.lang.String') { return STRING_RETURNS[name] || null; }
  if (fqn === 'java.lang.Enum') { return name === 'name' ? STRING : name === 'ordinal' || name === 'compareTo' ? prim('int') : null; }
  if (fqn === 'java.lang.StringBuilder' || fqn === 'java.lang.StringBuffer') {
    if (['append', 'insert', 'reverse', 'delete', 'deleteCharAt', 'replace'].includes(name)) { return recv; }
    if (name === 'length') { return prim('int'); }
    if (name === 'substring') { return STRING; }
    return null;
  }
  if (BOXES[fqn]) {
    if (/^parse/.test(name) || /Value$/.test(name)) { return prim(name.startsWith('parse') ? BOXES[fqn] : name.replace(/Value$/, '')); }
    if (name === 'valueOf') { return recv; }
    return null;
  }
  if (fqn === 'java.lang.Math') {
    if (['sqrt', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'pow', 'random', 'toRadians', 'toDegrees',
      'log', 'exp', 'floor', 'ceil', 'log10', 'hypot', 'cbrt', 'rint'].includes(name)) { return prim('double'); }
    if (['abs', 'max', 'min'].includes(name) && argTypes.length) {
      let best = null;
      for (const t of argTypes) { if (!t || t.k !== 'p' || !NUM_RANK[t.name]) { return null; } if (!best || NUM_RANK[t.name] > NUM_RANK[best]) { best = t.name; } }
      return prim(NUM_RANK[best] < 3 ? 'int' : best);
    }
    return null;
  }
  if (!isContainerType(fqn)) { return null; }
  if (isMapType(fqn)) {
    if (MAP_VALUE_METHODS.has(name)) { return a[1] || null; }
    if (name === 'values') { return lib('java.util.Collection', [a[1] || null]); }
    if (name === 'keySet') { return lib('java.util.Set', [a[0] || null]); }
    if (name === 'size') { return prim('int'); }
    if (name === 'containsKey' || name === 'containsValue' || name === 'isEmpty') { return prim('boolean'); }
    return null;
  }
  if (/(^|\.)Map\.Entry$|(^|\.)Entry$/.test(fqn)) { return name === 'getKey' ? a[0] || null : name === 'getValue' ? a[1] || null : null; }
  if (name === 'iterator' || name === 'listIterator') { return lib('java.util.Iterator', [a[0] || null]); }
  if (name === 'subList' || name === 'clone') { return recv; }
  if (name === 'size' || name === 'indexOf' || name === 'lastIndexOf') { return prim('int'); }
  if (name === 'contains' || name === 'isEmpty' || name === 'hasNext' || name === 'hasMoreElements') { return prim('boolean'); }
  if (name === 'add') { return argTypes.length === 1 ? prim('boolean') : null; }
  if (name === 'nextElement') { return a[0] || null; }
  if (LIB_ELEMENT_METHODS.has(name)) { return a[0] || null; }
  return null;
}

/** Element type when iterating over t in a for-each loop. */
function elementType(t) {
  if (!t) { return null; }
  if (t.dims) { return { ...t, dims: t.dims - 1 }; }
  if (t.k === 'l') { return isMapType(t.fqn) ? null : (t.args && t.args[0]) || null; }
  return null;
}

// ── Assignability, for overload choice ────────────────────────────────────────

/**
 * Whether an argument of type `arg` may be passed to a parameter of type `param`, following
 * Java's widening, boxing and subtyping rules as far as the type model allows. An unknown
 * type (null) on either side is accepted, so an unresolved argument never rules a candidate out.
 */
function assignable(table, arg, param) {
  if (!arg || !param) { return true; }
  if (arg.k === 'p' && arg.name === 'null') { return !(param.k === 'p' && !param.dims); }
  const ad = arg.dims || 0; const pd = param.dims || 0;
  if (param.k === 'l' && param.fqn === 'java.lang.Object' && !pd) { return true; }
  if (ad !== pd) { return false; }
  if (arg.k === 'p' && param.k === 'p') {
    if (ad) { return arg.name === param.name; }
    if (arg.name === param.name) { return true; }
    if (arg.name === 'boolean' || param.name === 'boolean') { return false; }
    if (arg.name === 'char') { return NUM_RANK[param.name] >= 3; }
    if (param.name === 'char') { return false; }
    return (NUM_RANK[arg.name] || 99) <= (NUM_RANK[param.name] || 0);
  }
  if (arg.k === 'p') { return param.k === 'l' && (BOXES[param.fqn] === arg.name || param.fqn === 'java.lang.Number' || param.fqn === 'java.lang.Comparable'); }
  if (param.k === 'p') { return arg.k === 'l' && !!BOXES[arg.fqn]; }
  if (arg.k === 'c' && param.k === 'c') { return T.isSubclass(table, arg.cls, param.cls); }
  if (arg.k === 'c' && param.k === 'l') {
    // a project class may extend or implement library types we cannot see, but it is never
    // a String, a boxed primitive or another final java.lang class
    return !(param.fqn === 'java.lang.String' || BOXES[param.fqn] || FINAL_LANG.has(param.fqn));
  }
  if (arg.k === 'l' && param.k === 'c') { return false; }
  if (arg.fqn === param.fqn) { return true; }
  if (arg.fqn === 'java.lang.String') { return ['java.lang.CharSequence', 'java.lang.Comparable', 'java.io.Serializable'].includes(param.fqn); }
  if (param.fqn === 'java.lang.String' || BOXES[param.fqn] || BOXES[arg.fqn]) { return false; }
  return true;
}

/** Whether two resolved types are the same class, library type or primitive with the same dims. */
function sameType(a, b) {
  if (!a || !b) { return false; }
  if (a.k !== b.k || (a.dims || 0) !== (b.dims || 0)) { return false; }
  return a.k === 'c' ? a.cls === b.cls : a.k === 'l' ? a.fqn === b.fqn : a.name === b.name;
}

/** Whether method m accepts n arguments (a varargs method accepts n >= params - 1). */
function arityOk(m, n) {
  const p = m.paramRefs.length;
  return m.varargs ? n >= p - 1 : n === p;
}

/**
 * Parameter types of m for n arguments. Fixed arity: the declared list. Variable arity (javac's
 * phase 3): the leading parameters, then the varargs component type for every remaining argument.
 */
function paramsFor(table, m, n, variable) {
  const ps = T.methodParams(table, m);
  if (!variable) { return ps; }
  const last = ps[ps.length - 1];
  const comp = last && last.dims ? { ...last, dims: last.dims - 1 } : null;
  return Array.from({ length: n }, (_, i) => (i < ps.length - 1 ? ps[i] : comp));
}

/** The most specific of the applicable candidates; `params(m)` gives each one's parameter list for this call. */
function mostSpecific(table, applicable, argTypes, params) {
  if (applicable.length <= 1) { return applicable; }
  const exact = applicable.filter(m => {
    const ps = params(m);
    return argTypes.every((a, i) => a && sameType(a, ps[i]));
  });
  if (exact.length) { return exact; }
  // most specific: m is kept unless another candidate's parameters are all assignable to m's
  const specific = applicable.filter(m => !applicable.some(o => o !== m && moreSpecific(table, params(o), params(m))));
  return specific.length ? specific : applicable;
}

/**
 * Choose among same-named methods (or constructors) for the given argument types, in javac's order:
 * first the candidates that apply by fixed arity (a varargs method counts when an array is passed
 * for its array parameter), then, only if none does, the varargs ones with the trailing arguments
 * checked against the component type. When neither phase finds one, the arity matches are kept.
 */
function chooseOverload(table, cands, argTypes) {
  const n = argTypes.length;
  if (cands.length <= 1) { return cands.filter(m => arityOk(m, n)); }
  const byArity = cands.filter(m => arityOk(m, n));
  if (byArity.length <= 1) { return byArity; }
  const applies = (m, variable) => {
    const ps = paramsFor(table, m, n, variable);
    return argTypes.every((a, i) => assignable(table, a, ps[i]));
  };
  const fixed = byArity.filter(m => m.paramRefs.length === n);
  const phase1 = fixed.filter(m => applies(m, false));
  if (phase1.length) { return mostSpecific(table, phase1, argTypes, m => paramsFor(table, m, n, false)); }
  const phase3 = byArity.filter(m => m.varargs && applies(m, true));
  if (phase3.length) { return mostSpecific(table, phase3, argTypes, m => paramsFor(table, m, n, true)); }
  return fixed.length ? fixed : byArity;
}

/** Whether every parameter type in pa is assignable to pb's and at least one differs: javac's "more specific" test. */
function moreSpecific(table, pa, pb) {
  if (pa.length !== pb.length) { return false; }
  let strict = false;
  for (let i = 0; i < pa.length; i++) {
    if (!pa[i] || !pb[i]) { return false; }
    if (!assignable(table, pa[i], pb[i])) { return false; }
    if (!sameType(pa[i], pb[i])) { strict = true; }
  }
  return strict;
}

/**
 * Methods named `name` visible on class ci: its own, then its project ancestors
 * (nearest first); an override hides the method it overrides (same parameter types).
 */
function visibleMethods(table, ci, name) {
  const out = []; const sigs = new Set();
  for (const c of [ci, ...T.ancestors(table, ci)]) {
    for (const m of c.methods.get(name) || []) {
      const sig = T.methodParams(table, m).map(sigOf).join(',') + (m.varargs ? '...' : '');
      if (sigs.has(sig)) { continue; }
      sigs.add(sig);
      out.push(m);
    }
  }
  return out;
}

/** Erased signature text of one resolved type ('?' for unknown), used to detect overrides. */
function sigOf(t) {
  if (!t) { return '?'; }
  const d = '[]'.repeat(t.dims || 0);
  return (t.k === 'c' ? t.cls.key : t.k === 'l' ? t.fqn : t.name) + d;
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/** Walks the bodies of one project with a scope stack and records edges, library nodes and call sites. */
class Resolver {
  /** `narrow(ids, file)` trims an ambiguous target list (the D6 narrower); identity when not given. */
  constructor(table, definitions, narrow) {
    this.table = table;
    this.definitions = definitions;
    this.narrow = narrow || ((ids) => ids);
    this.edges = [];
    this.seen = new Set();
    this.libraryNodes = new Map();
    this.sites = [];
    this.inBody = false;
  }

  // -- output --

  /** Record one call edge once; self-calls and calls outside a method (no src) are dropped. */
  addEdge(src, target, isLibrary) {
    if (!src || src === target) { return; }
    const key = `${src}|${target}`;
    if (this.seen.has(key)) { return; }
    this.seen.add(key);
    const e = { source: src, target };
    if (isLibrary) { e.isLibraryEdge = true; }
    this.edges.push(e);
  }

  /** Id of the library node `library::<fqn>::<name>`, creating the node on first use. */
  libraryTarget(fqn, name) {
    const id = `library::${fqn}::${name}`;
    if (!this.libraryNodes.has(id)) {
      this.libraryNodes.set(id, { id, name, file: null, line: 0, isLibrary: true, libraryName: fqn, language: 'java' });
    }
    return id;
  }

  /**
   * Record one call site: edges from the caller to its targets (narrowed when more than eight)
   * and a site entry with its form and, when nothing was linked, the reason.
   */
  site(env, tok, name, form, targets, reason) {
    if (!env.caller) { return; }
    const ids = targets.length > 8 ? this.narrow(targets, env.file) : targets;
    for (const t of ids) { this.addEdge(env.caller, t, t.startsWith('library::')); }
    this.sites.push({ file: env.file, line: tok ? tok.startLine : 0, col: tok ? tok.startColumn : 0, caller: env.caller,
      name, form, targets: ids, reason: ids.length ? null : (reason || 'no-definition') });
  }

  // -- scopes --

  /**
   * Variable `name` at the current point: locals innermost first, then fields (inherited and
   * outer ones), then static single imports. Returns { type, local | field } or null.
   */
  lookupVar(env, name) {
    for (let i = env.frames.length - 1; i >= 0; i--) {
      const f = env.frames[i];
      if (f.vars) { if (f.vars.has(name)) { return { type: f.vars.get(name), local: true }; } }
      else if (f.cls) {
        const fd = T.fieldOf(this.table, f.cls, name);
        if (fd) { return { type: T.resolvedFieldType(this.table, fd), field: true }; }
      }
    }
    const fi = env.fileInfo;
    const owner = fi && fi.staticSingle.get(name);
    if (owner) {
      const oc = T.resolveFqn(this.table, owner, env.file);
      if (oc) { const fd = T.fieldOf(this.table, oc.cls, name); if (fd) { return { type: T.resolvedFieldType(this.table, fd), field: true }; } }
    }
    return null;
  }

  /** Simple type name seen from the current class and lexical scope (javaTypes.lookupTypeName). */
  lookupType(env, name) {
    return T.lookupTypeName(this.table, name, env.cls, env.fileInfo, undefined, this.scopeOf(env));
  }

  /** Resolve a written type ref in the current class, method type parameters and lexical scope. */
  resolveRef(env, ref) {
    return T.resolveRef(this.table, ref, env.cls, env.fileInfo, env.methodTypeParams, undefined, this.scopeOf(env));
  }

  /**
   * The lexical scope at the current point, innermost first: the local-class Map of each
   * block that declared one and the ClassInfo of each enclosing class; null when no open
   * block declared a local class (then javaTypes resolves from env.cls alone).
   */
  scopeOf(env) {
    if (!env.frames.some(f => f.types)) { return null; }
    const scope = [];
    for (let i = env.frames.length - 1; i >= 0; i--) {
      const f = env.frames[i];
      if (f.types) { scope.push(f.types); } else if (f.cls) { scope.push(f.cls); }
    }
    return scope;
  }

  /** Bind local class `ci` in the innermost block: visible from here to the block's end. */
  declareType(env, ci) {
    const f = env.frames[env.frames.length - 1];
    if (f && f.vars) { (f.types || (f.types = new Map())).set(ci.simple, ci); }
    else { env.frames.push({ vars: new Map(), types: new Map([[ci.simple, ci]]) }); }
  }

  /** Bind a variable in the innermost block frame (a fresh one when the top frame is a class). */
  declare(env, name, type) {
    const f = env.frames[env.frames.length - 1];
    if (f && f.vars) { f.vars.set(name, type); } else { env.frames.push({ vars: new Map([[name, type]]) }); }
  }

  /** Open a block frame. */
  pushVars(env) { env.frames.push({ vars: new Map() }); }
  /** Close the innermost frame. */
  pop(env) { env.frames.pop(); }

  /** The type of `this` in the current class, or null outside a class. */
  thisType(env) { return env.cls ? { k: 'c', cls: env.cls, args: [], dims: 0 } : null; }

  // -- entry --

  /** Walk every top-level type declaration of one file; a file the table does not know is skipped. */
  resolveFile(file, cst) {
    const fileInfo = this.table.files.get(file);
    if (!fileInfo) { return; }
    const env = { file, fileInfo, cls: null, caller: null, frames: [], methodTypeParams: null };
    const ocu = kid(cst, 'ordinaryCompilationUnit');
    for (const td of kids(ocu, 'typeDeclaration')) { this.walk(td, env); }
  }

  /** Enter the class whose body is `body`; walk its members. */
  withClass(env, body, fn) {
    const ci = this.table.byPos.get(`${env.file}:${startOf(body)}`);
    if (!ci) { return this.walkChildren(body, env); }
    const saved = { cls: env.cls, caller: env.caller, mtp: env.methodTypeParams };
    if (ci.scope === null && this.inBody) { ci.scope = this.scopeOf(env); } // local or anonymous class
    env.frames.push({ cls: ci });
    env.cls = ci; env.caller = null;
    const savedIn = this.inBody; this.inBody = false;
    try { fn(); } finally {
      this.inBody = savedIn;
      env.frames.pop();
      env.cls = saved.cls; env.caller = saved.caller; env.methodTypeParams = saved.mtp;
    }
  }

  /**
   * Run `body` as the method or constructor `id`: its parameters are declared in a fresh frame
   * and calls inside it get `id` as caller (null when the analyzer has no node for it).
   */
  enterCallable(env, id, params, methodTypeParams, body) {
    const saved = { caller: env.caller, mtp: env.methodTypeParams, inBody: this.inBody };
    this.inBody = true;
    env.caller = this.definitions[id] ? id : null;
    env.methodTypeParams = methodTypeParams;
    this.pushVars(env);
    for (let i = 0; i < params.refs.length; i++) {
      if (params.names[i]) { this.declare(env, params.names[i], this.resolveRef(env, params.refs[i])); }
    }
    try { body(); } finally { this.pop(env); env.caller = saved.caller; env.methodTypeParams = saved.mtp; this.inBody = saved.inBody; }
  }

  // -- statements --

  /** Walk every child of a rule node. */
  walkChildren(node, env) {
    if (!node || isTok(node)) { return; }
    for (const k of Object.keys(node.children)) { for (const c of node.children[k]) { this.walk(c, env); } }
  }

  /**
   * Statement-level walk: opens class frames for type declarations, callable frames for methods
   * and constructors, block frames for blocks, loops, catch and try-with-resources, declares the
   * variables they introduce, and hands expressions to evalExpr.
   */
  walk(node, env) {
    if (!node || isTok(node)) { return; }
    switch (node.name) {
      case 'normalClassDeclaration': case 'normalInterfaceDeclaration': case 'recordDeclaration': {
        const body = kid(node, 'classBody') || kid(node, 'interfaceBody') || kid(node, 'recordBody');
        if (body) { this.withClass(env, body, () => this.walkChildren(body, env)); }
        return;
      }
      case 'enumDeclaration': {
        const body = kid(node, 'enumBody');
        if (body) { this.withClass(env, body, () => this.walkChildren(body, env)); }
        return;
      }
      case 'enumConstant': {
        const args = kid(node, 'argumentList');
        if (args) { this.evalArgs(env, args); }
        const cb = kid(node, 'classBody');
        if (cb) { this.withClass(env, cb, () => this.walkChildren(cb, env)); }
        return;
      }
      case 'annotation': return;
      case 'fieldDeclaration': case 'constantDeclaration': {
        const saved = env.caller; env.caller = null;   // field initialisers run outside any method
        try { this.walkChildren(kid(node, 'variableDeclaratorList'), env); } finally { env.caller = saved; }
        return;
      }
      case 'instanceInitializer': case 'staticInitializer': {
        const saved = env.caller; const savedIn = this.inBody; env.caller = null; this.inBody = true;
        try { this.walkChildren(node, env); } finally { env.caller = saved; this.inBody = savedIn; }
        return;
      }
      case 'methodDeclaration': case 'interfaceMethodDeclaration': {
        const header = kid(node, 'methodHeader');
        const decl = kid(header, 'methodDeclarator');
        const id = kid(decl, 'Identifier');
        const body = kid(node, 'methodBody');
        if (!id || !body) { return; }
        const mid = `${env.file}::${id.image}::${id.startLine}`;
        const mi = this.table.methodById.get(mid);
        const params = T.paramsOf(kid(decl, 'formalParameterList'));
        this.enterCallable(env, mid, params, mi ? mi.typeParams : null, () => this.walk(body, env));
        return;
      }
      case 'constructorDeclaration': {
        const decl = kid(node, 'constructorDeclarator');
        const idTok = T.firstIdent(kid(decl, 'simpleTypeName'));
        if (!idTok) { return; }
        const cid = `${env.file}::constructor::${idTok.startLine}`;
        const params = T.paramsOf(kid(decl, 'formalParameterList'));
        const body = kid(node, 'constructorBody');
        this.enterCallable(env, cid, params, null, () => {
          // No this(..)/super(..) written: the compiler inserts super(), which runs the
          // base class's no-argument constructor.
          if (!kid(body, 'explicitConstructorInvocation') && env.cls && env.cls.kind === 'class') {
            const sc = T.superclassOf(this.table, env.cls);
            if (sc && sc.k === 'c' && sc.cls.ctors.length) { this.linkCtor(env, idTok, sc.cls, [], 'ctor-super-implicit'); }
          }
          this.walk(body, env);
        });
        return;
      }
      case 'explicitConstructorInvocation': { this.explicitCtor(env, node); return; }
      case 'block': case 'switchBlock': case 'basicForStatement': {
        this.pushVars(env);
        try { this.walkChildren(node, env); } finally { this.pop(env); }
        return;
      }
      case 'localVariableDeclaration': { this.localVars(env, node); return; }
      case 'enhancedForStatement': {
        const it = this.evalExpr(env, kid(node, 'expression'));
        const ref = T.typeRef(kid(node, 'localVariableType'));
        const vid = kid(node, 'variableDeclaratorId');
        let t = ref && ref.var ? elementType(it) : this.resolveRef(env, T.withDims(ref, T.dimsCount(kid(vid, 'dims'))));
        this.pushVars(env);
        try {
          const id = kid(vid, 'Identifier');
          if (id) { this.declare(env, id.image, t); }
          this.walk(kid(node, 'statement'), env);
        } finally { this.pop(env); }
        return;
      }
      case 'catchClause': {
        const cfp = kid(node, 'catchFormalParameter');
        this.pushVars(env);
        try {
          const id = kid(kid(cfp, 'variableDeclaratorId'), 'Identifier');
          const ct = kid(cfp, 'catchType');
          const multi = kids(ct, 'classType').length > 0;
          if (id) { this.declare(env, id.image, multi ? null : this.resolveRef(env, T.typeRef(ct))); }
          this.walk(kid(node, 'block'), env);
        } finally { this.pop(env); }
        return;
      }
      case 'tryWithResourcesStatement': {
        this.pushVars(env);
        try { this.walkChildren(node, env); } finally { this.pop(env); }
        return;
      }
      case 'resourceInit': {
        const t0 = this.evalExpr(env, kid(node, 'expression'));
        const ref = T.typeRef(kid(node, 'localVariableType'));
        const id = kid(node, 'Identifier');
        if (id) { this.declare(env, id.image, ref && ref.var ? t0 : this.resolveRef(env, ref)); }
        return;
      }
      case 'classDeclaration': case 'interfaceDeclaration':
        if (env.cls && this.inBody) {
          const lc = T.ensureLocal(this.table, env.file, node, env.cls);
          if (lc) { this.declareType(env, lc); }
        }
        this.walkChildren(node, env); return;
      case 'expression': this.evalExpr(env, node); return;
      case 'primary': this.evalPrimary(env, node); return;
      default: this.walkChildren(node, env);
    }
  }

  /** Declare the variables of a localVariableDeclaration; `var` takes the initialiser's type. */
  localVars(env, node) {
    const ref = T.typeRef(kid(node, 'localVariableType'));
    for (const vd of kids(kid(node, 'variableDeclaratorList'), 'variableDeclarator')) {
      const vid = kid(vd, 'variableDeclaratorId');
      const init = kid(vd, 'variableInitializer');
      let initType = null;
      if (init) {
        const ex = kid(init, 'expression');
        if (ex) { initType = this.evalExpr(env, ex); } else { this.walkChildren(init, env); }
      }
      const id = kid(vid, 'Identifier');
      if (!id) { continue; }
      const t = ref && ref.var ? initType : this.resolveRef(env, T.withDims(ref, T.dimsCount(kid(vid, 'dims'))));
      this.declare(env, id.image, t);
    }
  }

  // -- expressions (walk and type in one pass) --

  /**
   * Walk an expression node and return its static type (null when unknown). A ternary takes the
   * first non-null branch type; a lambda is walked but has no type.
   */
  evalExpr(env, node) {
    if (!node) { return null; }
    if (isTok(node)) { return null; }
    switch (node.name) {
      case 'expression': {
        const tern = node.children.ternaryExpression;
        if (tern) { return this.evalExpr(env, tern[0]); }
        const lam = kid(node, 'lambdaExpression');
        if (lam) { this.lambda(env, lam); return null; }
        return this.evalExpr(env, kid(node, 'ternaryExpression'));
      }
      case 'ternaryExpression': {
        const b = this.evalExpr(env, kid(node, 'binaryExpression'));
        if (!node.children.expression) { return b; }
        const branches = kids(node, 'expression');
        if (!branches.length) { return b; }
        const t1 = this.evalExpr(env, branches[0]);
        const t2 = this.evalExpr(env, branches[1]);
        if (t1 && !(t1.k === 'p' && t1.name === 'null')) { return t1; }
        return t2;
      }
      case 'binaryExpression': return this.binary(env, node);
      case 'unaryExpression': case 'unaryExpressionNotPlusMinus': {
        const t = this.evalPrimary(env, kid(node, 'primary'));
        if (Object.keys(node.children).length === 1) { return t; }
        const pre = kids(node, 'UnaryPrefixOperator').concat(kids(node, 'Not'), kids(node, 'Minus'), kids(node, 'Plus'), kids(node, 'Tilde'));
        if (kids(node, 'Not').length) { return prim('boolean'); }
        if (pre.length && t && t.k === 'p') { return NUM_RANK[t.name] && NUM_RANK[t.name] < 3 ? prim('int') : t; }
        if (t && t.k === 'l' && BOXES[t.fqn] && pre.length) { return prim(BOXES[t.fqn]); }
        return t;
      }
      case 'primary': return this.evalPrimary(env, node);
      case 'lambdaExpression': this.lambda(env, node); return null;
      default: this.walkChildren(node, env); return null;
    }
  }

  /**
   * Type of a binaryExpression: an assignment keeps the left operand's type, comparisons and
   * logical operators give boolean, `+` with a String gives String, numeric operators the
   * promoted type (int at least; a shift takes the left operand's width).
   */
  binary(env, node) {
    const ch = node.children;
    if (ch.unaryExpression && ch.unaryExpression.length === 1 && Object.keys(ch).length === 1) { return this.evalExpr(env, ch.unaryExpression[0]); }
    const operands = kids(node, 'unaryExpression').map(u => this.evalExpr(env, u));
    const rhs = kids(node, 'expression').map(e => this.evalExpr(env, e));
    for (const p of kids(node, 'pattern')) { this.pattern(env, p); }
    const toks = [];
    for (const k of Object.keys(node.children)) { for (const c of node.children[k]) { if (isTok(c)) { toks.push(c); } } }
    if (!toks.length) { return operands[0] || null; }
    const ops = toks.map(t => t.image);
    if (ops.some(o => /=$/.test(o) && !['==', '!=', '<=', '>='].includes(o))) { return operands[0] || null; }
    if (ops.some(o => ['&&', '||', '==', '!=', '<=', '>=', 'instanceof'].includes(o))) { return prim('boolean'); }
    const lt = toks.filter(t => t.image === '<' || t.image === '>').sort((a, b) => a.startOffset - b.startOffset);
    const shiftOffsets = new Set();
    for (let i = 0; i + 1 < lt.length; i++) { if (lt[i].startOffset + 1 === lt[i + 1].startOffset) { shiftOffsets.add(lt[i].startOffset); shiftOffsets.add(lt[i + 1].startOffset); } }
    if (lt.some(t => !shiftOffsets.has(t.startOffset))) { return prim('boolean'); }
    const all = operands.concat(rhs);
    if (ops.includes('+') && all.some(t => t && t.k === 'l' && t.fqn === 'java.lang.String' && !t.dims)) { return STRING; }
    let best = null;
    for (const t of all) {
      const n = t && (t.k === 'p' ? t.name : t.k === 'l' ? BOXES[t.fqn] : null);
      if (!n || !NUM_RANK[n] || t.dims) { return null; }
      if (!best || NUM_RANK[n] > NUM_RANK[best]) { best = n; }
    }
    if (!best) { return null; }
    if (shiftOffsets.size) { return prim(NUM_RANK[operands[0] && operands[0].name] >= 4 ? 'long' : 'int'); }
    return prim(NUM_RANK[best] < 3 ? 'int' : best);
  }

  /** `x instanceof Foo f`: declare the pattern variable f in the current scope. */
  pattern(env, p) {
    // `x instanceof Foo f` binds f in the current scope
    let tp = p;
    while (tp && tp.name !== 'typePattern' && kid(tp, 'primaryPattern')) { tp = kid(tp, 'primaryPattern'); }
    const tpat = tp && (tp.name === 'typePattern' ? tp : kid(tp, 'typePattern'));
    const lvd = tpat && kid(tpat, 'localVariableDeclaration');
    if (lvd) { this.localVars(env, lvd); }
  }

  /** Walk a lambda in its own frame; inferred parameters have unknown type, explicit ones their declared type. */
  lambda(env, node) {
    this.pushVars(env);
    try {
      const lp = kid(node, 'lambdaParameters');
      const single = kid(lp, 'Identifier');
      if (single) { this.declare(env, single.image, null); }
      const braces = kid(lp, 'lambdaParametersWithBraces');
      const list = kid(braces, 'lambdaParameterList');
      for (const id of kids(kid(list, 'inferredLambdaParameterList'), 'Identifier')) { this.declare(env, id.image, null); }
      for (const p of kids(kid(list, 'explicitLambdaParameterList'), 'lambdaParameter')) {
        const reg = kid(p, 'regularLambdaParameter');
        const vid = reg && kid(reg, 'variableDeclaratorId');
        const id = vid && kid(vid, 'Identifier');
        if (id) { const r = T.typeRef(kid(reg, 'lambdaParameterType')); this.declare(env, id.image, r && r.var ? null : this.resolveRef(env, r)); }
      }
      const body = kid(node, 'lambdaBody');
      const ex = kid(body, 'expression');
      if (ex) { this.evalExpr(env, ex); } else { this.walkChildren(body, env); }
    } finally { this.pop(env); }
  }

  /** Walk the arguments of a call and return their types, in order. */
  evalArgs(env, argList) {
    return argList ? kids(argList, 'expression').map(e => this.evalExpr(env, e)) : [];
  }

  /** Type of a literal node: String, char, boolean, null, int / long or float / double by suffix. */
  literalType(lit) {
    if (kid(lit, 'StringLiteral') || kid(lit, 'TextBlock')) { return STRING; }
    if (kid(lit, 'CharLiteral')) { return prim('char'); }
    if (kid(lit, 'True') || kid(lit, 'False')) { return prim('boolean'); }
    if (kid(lit, 'Null')) { return prim('null'); }
    const il = kid(lit, 'integerLiteral');
    if (il) {
      const tok = Object.values(il.children)[0][0];
      return prim(/[lL]$/.test(tok.image) ? 'long' : 'int');
    }
    const fl = kid(lit, 'floatingPointLiteral');
    if (fl) {
      const tok = Object.values(fl.children)[0][0];
      return prim(/[fF]$/.test(tok.image) ? 'float' : 'double');
    }
    if (kid(lit, 'booleanLiteral')) { return prim('boolean'); }
    return null;
  }

  /** `primary` = prefix + suffixes; walks every call in the chain and returns the type. */
  evalPrimary(env, node) {
    if (!node) { return null; }
    const prefix = kid(node, 'primaryPrefix');
    const sufs = kids(node, 'primarySuffix');
    let cur = null;      // { t: type|null, st: bool (a type, not a value) }
    let i = 0;
    if (!prefix) { return null; }
    if (kid(prefix, 'literal')) {
      cur = { t: this.literalType(kid(prefix, 'literal')) };
    } else if (kid(prefix, 'This')) {
      const tok = kid(prefix, 'This');
      if (sufs[0] && kid(sufs[0], 'methodInvocationSuffix')) {
        // this(..) parsed as a primary
        const args = this.evalArgs(env, kid(kid(sufs[0], 'methodInvocationSuffix'), 'argumentList'));
        this.linkCtor(env, tok, env.cls, args, 'ctor-this');
        return null;
      }
      cur = { t: this.thisType(env), isThis: true };
    } else if (kid(prefix, 'fqnOrRefType')) {
      const r = this.fqnPrefix(env, kid(prefix, 'fqnOrRefType'), sufs);
      cur = r.cur; i = r.consumed;
    } else if (kid(prefix, 'castExpression')) {
      cur = { t: this.cast(env, kid(prefix, 'castExpression')) };
    } else if (kid(prefix, 'parenthesisExpression')) {
      cur = { t: this.evalExpr(env, kid(kid(prefix, 'parenthesisExpression'), 'expression')) };
    } else if (kid(prefix, 'newExpression')) {
      cur = { t: this.newExpr(env, kid(prefix, 'newExpression'), null) };
    } else {
      this.walkChildren(prefix, env);
      cur = { t: null };
    }
    for (; i < sufs.length; i++) {
      const s = sufs[i];
      const id = kid(s, 'Identifier');
      if (id && kid(s, 'Dot')) {
        const next = sufs[i + 1];
        if (next && kid(next, 'methodInvocationSuffix')) {
          const args = this.evalArgs(env, kid(kid(next, 'methodInvocationSuffix'), 'argumentList'));
          cur = { t: this.call(env, cur, id, args, this.formOf(cur)) };
          i++;
        } else {
          cur = this.fieldAccess(env, cur, id.image);
        }
        continue;
      }
      if (kid(s, 'This')) { cur = { t: cur && cur.st ? cur.t : null }; continue; }   // Outer.this
      if (kid(s, 'unqualifiedClassInstanceCreationExpression')) {
        cur = { t: this.classInstance(env, kid(s, 'unqualifiedClassInstanceCreationExpression'), cur) };
        continue;
      }
      if (kid(s, 'methodInvocationSuffix')) {
        this.evalArgs(env, kid(kid(s, 'methodInvocationSuffix'), 'argumentList'));
        cur = { t: null };
        continue;
      }
      if (kid(s, 'arrayAccessSuffix')) {
        this.evalExpr(env, kid(kid(s, 'arrayAccessSuffix'), 'expression'));
        const t = cur && cur.t;
        cur = { t: t && t.dims ? { ...t, dims: t.dims - 1 } : null, arr: true };
        continue;
      }
      if (kid(s, 'classLiteralSuffix')) { cur = { t: lib('java.lang.Class') }; continue; }
      if (kid(s, 'methodReferenceSuffix')) { cur = { t: null }; continue; }
      this.walkChildren(s, env);
      cur = { t: null };
    }
    return cur ? cur.t : null;
  }

  /** The call form of a receiver value for the site record: this, super, static, array, local, field or receiver. */
  formOf(cur) {
    if (!cur) { return 'unknown'; }
    if (cur.isThis) { return 'this'; }
    if (cur.sup) { return 'super'; }
    if (cur.st) { return 'static'; }
    if (cur.arr) { return 'array'; }
    return cur.form || 'receiver';
  }

  /** fqnOrRefType prefix: a name chain, possibly ending in the name of the invoked method. */
  fqnPrefix(env, fqn, sufs) {
    const parts = [];
    const first = kid(fqn, 'fqnOrRefTypePartFirst');
    const pc = kid(first, 'fqnOrRefTypePartCommon');
    parts.push(kid(pc, 'Identifier') || kid(pc, 'Super'));
    for (const r of kids(fqn, 'fqnOrRefTypePartRest')) {
      const c = kid(r, 'fqnOrRefTypePartCommon');
      parts.push(kid(c, 'Identifier') || kid(c, 'Super'));
    }
    if (parts.some(p => !p)) { return { cur: { t: null }, consumed: 0 }; }
    const invoked = sufs[0] && kid(sufs[0], 'methodInvocationSuffix');
    if (kid(fqn, 'dims')) { return { cur: { t: null }, consumed: 0 }; }  // Foo[]::new and similar
    if (invoked) {
      const nameTok = parts[parts.length - 1];
      const args = this.evalArgs(env, kid(invoked, 'argumentList'));
      if (parts.length === 1) {
        return { cur: { t: this.bareCall(env, nameTok, args) }, consumed: 1 };
      }
      const recv = this.nameChain(env, parts.slice(0, -1));
      return { cur: { t: this.call(env, recv, nameTok, args, this.formOf(recv)) }, consumed: 1 };
    }
    return { cur: this.nameChain(env, parts), consumed: 0 };
  }

  /** Resolve an ambiguous name a.b.c (variable, field chain, type, or package-qualified type). */
  nameChain(env, parts) {
    let cur; let i = 1;
    const p0 = parts[0];
    if (p0.tokenType.name === 'Super') {
      const sc = env.cls ? T.superclassOf(this.table, env.cls) : null;
      cur = { t: sc, sup: true };
    } else {
      const v = this.lookupVar(env, p0.image);
      if (v) { cur = { t: v.type, form: v.local ? 'local' : 'field' }; }
      else {
        const ty = this.lookupType(env, p0.image);
        if (ty) { cur = { t: { ...ty, args: [], dims: 0 }, st: true }; }
        else {
          // package-qualified type: a.b.C
          cur = null;
          for (let j = 1; j < parts.length && !cur; j++) {
            const name = parts.slice(0, j + 1).map(p => p.image).join('.');
            const pc = T.resolveFqn(this.table, name, env.file);
            if (pc) { cur = { t: { ...pc, args: [], dims: 0 }, st: true }; i = j + 1; }
          }
          if (!cur) {
            const up = parts.findIndex(p => /^[A-Z]/.test(p.image));
            if (up > 0) { cur = { t: lib(parts.slice(0, up + 1).map(p => p.image).join('.')), st: true }; i = up + 1; }
            else { return { t: null }; }
          }
        }
      }
    }
    for (; i < parts.length; i++) {
      if (parts[i].tokenType.name === 'Super') { cur = { t: null }; continue; }
      cur = this.fieldAccess(env, cur, parts[i].image);
    }
    return cur;
  }

  /**
   * `cur.name` as a field (own, inherited or outer), an array's length, a member type when cur
   * is a type, or a known library static field (System.out). Unknown: { t: null }.
   */
  fieldAccess(env, cur, name) {
    const t = cur && cur.t;
    if (!t) { return { t: null }; }
    if (t.dims) { return { t: name === 'length' ? prim('int') : null }; }
    if (t.k === 'c') {
      const f = T.fieldOf(this.table, t.cls, name);
      if (f) { return { t: T.resolvedFieldType(this.table, f), form: 'field' }; }
      if (cur.st) {
        const m = T.lookupTypeName(this.table, name, t.cls, t.cls.fileInfo);
        if (m && m.k === 'c' && m.cls.outer === t.cls) { return { t: { ...m, args: [], dims: 0 }, st: true }; }
        const mt = this.memberTypeOf(t.cls, name);
        if (mt) { return { t: { k: 'c', cls: mt, args: [], dims: 0 }, st: true }; }
      }
      return { t: null };
    }
    if (t.k === 'l') {
      const sf = LIB_STATIC_FIELDS[`${t.fqn}.${name}`];
      if (sf) { return { t: sf }; }
      if (cur.st && /^[A-Z][a-z]/.test(name)) { return { t: lib(`${t.fqn}.${name}`), st: true }; }
      return { t: null };
    }
    return { t: null };
  }

  /** Member type `name` of ci or of a project ancestor, or null. */
  memberTypeOf(ci, name) {
    for (const c of [ci, ...T.ancestors(this.table, ci)]) { const m = c.memberTypes.get(name); if (m) { return m; } }
    return null;
  }

  /** Walk the operand of a cast and return the cast type (reference or primitive). */
  cast(env, ce) {
    const ref = kid(ce, 'referenceTypeCastExpression');
    if (ref) {
      const inner = kid(ref, 'unaryExpressionNotPlusMinus') || kid(ref, 'lambdaExpression');
      this.evalExpr(env, inner);
      return this.resolveRef(env, T.typeRef(kid(ref, 'referenceType')));
    }
    const pc = kid(ce, 'primitiveCastExpression');
    if (pc) {
      this.evalExpr(env, kid(pc, 'unaryExpression'));
      return this.resolveRef(env, T.typeRef(kid(pc, 'primitiveType')));
    }
    this.walkChildren(ce, env);
    return null;
  }

  /** `new`: an array creation gives the array type (dims from the expression), a class instance goes to classInstance. */
  newExpr(env, ne, outer) {
    const ace = kid(ne, 'arrayCreationExpression');
    if (ace) {
      this.walkChildren(ace, env);
      const base = kid(ace, 'primitiveType') ? T.typeRef(kid(ace, 'primitiveType')) : T.typeRef(kid(ace, 'classOrInterfaceType'));
      const def = kid(ace, 'arrayCreationDefaultInitSuffix');
      const exp = kid(ace, 'arrayCreationExplicitInitSuffix');
      const dims = def ? kids(kid(def, 'dimExprs'), 'dimExpr').length + T.dimsCount(kid(def, 'dims'))
        : T.dimsCount(kid(exp, 'dims'));
      return this.resolveRef(env, T.withDims(base, dims));
    }
    const uci = kid(ne, 'unqualifiedClassInstanceCreationExpression');
    return uci ? this.classInstance(env, uci, outer) : null;
  }

  /** new X(..) [ { body } ] — links X's constructor (not for anonymous classes, whose
   *  constructor is implicit) and walks the anonymous body. */
  classInstance(env, uci, outer) {
    const ref = T.typeRef(kid(uci, 'classOrInterfaceTypeToInstantiate'));
    let t;
    if (outer && outer.t && outer.t.k === 'c' && ref && ref.names.length === 1) {
      const m = this.memberTypeOf(outer.t.cls, ref.names[0]);
      t = m ? { k: 'c', cls: m, args: [], dims: 0 } : null;
    } else {
      t = this.resolveRef(env, ref);
    }
    if (t && ref && ref.diamond) { t = { ...t, args: [] }; }
    const args = this.evalArgs(env, kid(uci, 'argumentList'));
    const body = kid(uci, 'classBody');
    const tok = kid(kid(uci, 'classOrInterfaceTypeToInstantiate'), 'Identifier');
    if (body) {
      T.ensureAnon(this.table, env.file, body, env.cls, ref);
      this.withClass(env, body, () => this.walkChildren(body, env));
      return t;
    }
    if (t && t.k === 'c') { this.linkCtor(env, tok, t.cls, args, 'new'); }
    else if (t && t.k === 'l') { this.site(env, tok, '<init>', 'new', [this.libraryTarget(t.fqn, '<init>')]); }
    else { this.site(env, tok, '<init>', 'new', [], 'unknown-type'); }
    return t;
  }

  /**
   * Record a constructor call site on project class ci, choosing the overload by the argument
   * types; a class without written constructors is recorded as `implicit-constructor`.
   */
  linkCtor(env, tok, ci, args, form) {
    if (!ci) { this.site(env, tok, '<init>', form, [], 'unknown-type'); return; }
    if (!ci.ctors.length) { this.site(env, tok, '<init>', form, [], 'implicit-constructor'); return; }
    const chosen = chooseOverload(this.table, ci.ctors, args);
    this.site(env, tok, '<init>', form, chosen.map(m => m.id));
  }

  /**
   * `this(..)` or `super(..)` at the start of a constructor body: link the own or base class
   * constructor (a library base class gets a library edge).
   */
  explicitCtor(env, node) {
    const u = kid(node, 'unqualifiedExplicitConstructorInvocation');
    const q = kid(node, 'qualifiedExplicitConstructorInvocation');
    const inv = u || q;
    if (q) { this.walk(kid(q, 'expressionName'), env); }
    const args = this.evalArgs(env, kid(inv, 'argumentList'));
    const isThis = u && kid(u, 'This');
    const tok = kid(inv, 'This') || kid(inv, 'Super');
    if (!env.cls) { return; }
    if (isThis) { this.linkCtor(env, tok, env.cls, args, 'ctor-this'); return; }
    const sc = T.superclassOf(this.table, env.cls);
    if (sc && sc.k === 'c') { this.linkCtor(env, tok, sc.cls, args, 'ctor-super'); }
    else if (sc && sc.k === 'l') { this.site(env, tok, '<init>', 'ctor-super', [this.libraryTarget(sc.fqn, '<init>')]); }
  }

  /** Bare m(..): innermost class (with its ancestors) that has a method m, then static imports. */
  bareCall(env, tok, args) {
    const name = tok.image;
    let libFallback = null;
    for (let i = env.frames.length - 1; i >= 0; i--) {
      const f = env.frames[i];
      if (!f.cls) { continue; }
      const cands = visibleMethods(this.table, f.cls, name);
      if (cands.length) {
        const chosen = chooseOverload(this.table, cands, args);
        this.site(env, tok, name, 'bare', chosen.map(m => m.id));
        return chosen.length ? this.retType(chosen[0], null) : null;
      }
      if (!libFallback) {
        const ls = T.libSuperOf(this.table, f.cls);
        if (ls) { libFallback = ls; }
      }
    }
    const fi = env.fileInfo;
    const owner = fi && fi.staticSingle.get(name);
    const owners = owner ? [owner] : (fi ? fi.staticWildcard : []);
    for (const o of owners) {
      const oc = T.resolveFqn(this.table, o, env.file);
      if (oc) {
        const cands = visibleMethods(this.table, oc.cls, name);
        if (cands.length) {
          const chosen = chooseOverload(this.table, cands, args);
          this.site(env, tok, name, 'static-import', chosen.map(m => m.id));
          return chosen.length ? this.retType(chosen[0], null) : null;
        }
      } else if (owner) {
        this.site(env, tok, name, 'static-import', [this.libraryTarget(o, name)]);
        return libReturn(lib(o), name, args);
      }
    }
    if (!libFallback && OBJECT_METHODS.has(name) && env.cls) { libFallback = 'java.lang.Object'; }
    if (libFallback) {
      this.site(env, tok, name, 'bare', [this.libraryTarget(libFallback, name)]);
      return libReturn(lib(libFallback), name, args);
    }
    if (fi && fi.staticWildcard.length === 1 && !T.resolveFqn(this.table, fi.staticWildcard[0], env.file)) {
      const o = fi.staticWildcard[0];
      this.site(env, tok, name, 'static-import', [this.libraryTarget(o, name)]);
      return libReturn(lib(o), name, args);
    }
    this.site(env, tok, name, 'bare', [], 'no-definition');
    return null;
  }

  /** recv.m(..) */
  call(env, recv, tok, args, form) {
    const name = tok.image;
    const t = recv && recv.t;
    if (!t) { this.site(env, tok, name, form, [], 'unknown-type'); return null; }
    if (t.dims) {
      this.site(env, tok, name, form, [this.libraryTarget('java.lang.Object', name)]);
      return name === 'clone' ? t : libReturn(lib('java.lang.Object'), name, args);
    }
    if (t.k === 'p') { this.site(env, tok, name, form, [], 'unknown-type'); return null; }
    if (t.k === 'c') {
      const cands = visibleMethods(this.table, t.cls, name);
      if (cands.length) {
        const chosen = chooseOverload(this.table, cands, args);
        this.site(env, tok, name, form, chosen.map(m => m.id));
        return chosen.length ? this.retType(chosen[0], t) : null;
      }
      const ls = T.libSuperOf(this.table, t.cls) || (OBJECT_METHODS.has(name) ? 'java.lang.Object' : null);
      if (!ls) { this.site(env, tok, name, form, [], 'no-definition'); return null; }
      this.site(env, tok, name, form, [this.libraryTarget(ls, name)]);
      return libReturn(lib(ls), name, args);
    }
    this.site(env, tok, name, form, [this.libraryTarget(t.fqn, name)]);
    return libReturn(t, name, args);
  }

  /** Declared return type; a class type variable is substituted from the receiver's type arguments. */
  retType(m, recv) {
    const r = T.methodReturn(this.table, m);
    if (r && r.tvar && recv && recv.k === 'c' && recv.args && recv.args.length && recv.cls === m.owner) {
      const idx = m.owner.typeParams.findIndex(tp => tp.name === r.tvar);
      if (idx >= 0 && recv.args[idx]) { return { ...recv.args[idx], dims: (recv.args[idx].dims || 0) + ((r.dims || 0) - 0) }; }
    }
    if (r && r.k === 'p' && r.name === 'void') { return null; }
    return r;
  }
}

/**
 * Resolve every call of the given files. `getCst(file)` returns the parsed CST,
 * `definitions` are the analyzer's method nodes (id → node), `narrow` the D6 narrower,
 * `prebuiltTable` the type table built during the definitions pass (else built here).
 */
function resolveCalls(files, getCst, definitions, narrow, prebuiltTable) {
  const table = prebuiltTable ? T.finalizeTable(prebuiltTable) : T.buildTypeTable(files, getCst);
  const r = new Resolver(table, definitions, narrow);
  for (const file of files) {
    const cst = getCst(file);
    if (!cst) { continue; }
    try { r.resolveFile(file, cst); } catch { /* skip files that crash the walk */ }
  }
  return { edges: r.edges, libraryNodes: [...r.libraryNodes.values()], sites: r.sites, table };
}

module.exports = { resolveCalls, Resolver, chooseOverload, assignable, libReturn };
