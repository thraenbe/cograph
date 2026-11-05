/**
 * javaTypes.js — project type table for the Java analyzer (pass 1 of declared-type
 * resolution). Built from the same java-parser CSTs the analyzer already parses, so
 * no extra parse and no compiler or JDK model is needed.
 *
 * Per file: package, imports (single type, wildcard, static single, static wildcard)
 * and top-level types. Per class (top level, nested, inner, local, anonymous, enum,
 * interface): full name, outer class, extends / implements as written, type
 * parameters, fields with declared types, methods with parameter types, varargs,
 * return type and the CoGraph node id, constructors.
 *
 * Types are resolved lazily (resolveRef) in the context of the class that wrote them,
 * because a name can only be bound once every file's declarations are known.
 *
 * Resolved type: { k: 'c', cls, args, dims }   project class (ClassInfo)
 *                { k: 'l', fqn, args, dims }   library class, by fully qualified name
 *                { k: 'p', name, dims }        primitive, 'null' or 'void'
 *                null                          unknown
 */
'use strict';

// ── CST access ────────────────────────────────────────────────────────────────

const kids = (n, k) => (n && n.children && n.children[k]) || [];
const kid = (n, k) => kids(n, k)[0];
const isTok = (n) => n && n.image !== undefined;

/** Smallest start offset in a CST node (tokens carry startOffset, rules a location). */
function startOf(n) {
  if (!n) { return -1; }
  if (isTok(n)) { return n.startOffset; }
  if (n.location && Number.isFinite(n.location.startOffset)) { return n.location.startOffset; }
  let best = Infinity;
  for (const k of Object.keys(n.children || {})) {
    for (const c of n.children[k]) { const s = startOf(c); if (s >= 0 && s < best) { best = s; } }
  }
  return best === Infinity ? -1 : best;
}

/** First Identifier token anywhere below n (document order). */
function firstIdent(n) {
  let best = null;
  (function rec(x) {
    if (!x) { return; }
    if (isTok(x)) {
      if (x.tokenType && x.tokenType.name === 'Identifier' && (!best || x.startOffset < best.startOffset)) { best = x; }
      return;
    }
    for (const k of Object.keys(x.children || {})) { for (const c of x.children[k]) { rec(c); } }
  })(n);
  return best;
}

/** Count `[]` pairs in a dims node. */
const dimsCount = (dimsNode) => (dimsNode ? kids(dimsNode, 'LSquare').length : 0);

// ── Unresolved type references (as written) ───────────────────────────────────
// { prim: 'int', dims } | { names: ['java','util','List'], args: [ref], dims } |
// { var: true } (local `var`) | null

const PRIM_TOKENS = ['Int', 'Long', 'Short', 'Byte', 'Char', 'Float', 'Double', 'Boolean'];

function primName(n) {
  let found = null;
  (function rec(x) {
    if (!x || found) { return; }
    if (isTok(x)) { if (PRIM_TOKENS.includes(x.tokenType.name)) { found = x.image; } return; }
    for (const k of Object.keys(x.children || {})) { for (const c of x.children[k]) { rec(c); } }
  })(n);
  return found;
}

/** Identifiers + last typeArguments of a class type node (classType, unannClassType, ...). */
function classTypeRef(n, dims) {
  const ids = kids(n, 'Identifier').map(t => t.image);
  if (!ids.length) { return null; }
  const targs = kids(n, 'typeArguments');
  const last = targs[targs.length - 1];
  const args = last ? kids(kid(last, 'typeArgumentList'), 'typeArgument').map(typeRef) : [];
  return { names: ids, args, dims: dims || 0 };
}

/** Unresolved reference for any CST type node the grammar produces. */
function typeRef(n) {
  if (!n) { return null; }
  switch (n.name) {
    case 'unannType':
    case 'localVariableType':
    case 'lambdaParameterType': {
      if (kid(n, 'Var')) { return { var: true }; }
      const p = kid(n, 'unannPrimitiveTypeWithOptionalDimsSuffix');
      if (p) { return { prim: primName(p), dims: dimsCount(kid(p, 'dims')) }; }
      const r = kid(n, 'unannReferenceType');
      if (r) { return typeRef(r); }
      const u = kid(n, 'unannType');
      return u ? typeRef(u) : null;
    }
    case 'unannReferenceType': {
      const ci = kid(n, 'unannClassOrInterfaceType');
      const ct = ci && (kid(ci, 'unannClassType') || kid(ci, 'unannInterfaceType'));
      const inner = ct && (ct.name === 'unannInterfaceType' ? kid(ct, 'unannClassType') : ct);
      const tv = kid(n, 'unannTypeVariable');
      if (inner) { return classTypeRef(inner, dimsCount(kid(n, 'dims'))); }
      if (tv) { return { names: [kid(tv, 'Identifier').image], args: [], dims: dimsCount(kid(n, 'dims')) }; }
      return null;
    }
    case 'referenceType': {
      const prim = kid(n, 'primitiveType');
      if (prim) { return { prim: primName(prim), dims: dimsCount(kid(n, 'dims')) }; }
      const ci = kid(n, 'classOrInterfaceType');
      return ci ? withDims(typeRef(ci), dimsCount(kid(n, 'dims'))) : null;
    }
    case 'classOrInterfaceType': {
      const ct = kid(n, 'classType') || kid(n, 'interfaceType');
      return ct ? typeRef(ct) : null;
    }
    case 'interfaceType': return typeRef(kid(n, 'classType'));
    case 'classType':
    case 'unannClassType':
    case 'classOrInterfaceTypeToInstantiate':
    case 'exceptionType':
      if (n.name === 'exceptionType') { return typeRef(kid(n, 'classType')); }
      if (n.name === 'classOrInterfaceTypeToInstantiate') {
        const ids = kids(n, 'Identifier').map(t => t.image);
        const tad = kid(n, 'typeArgumentsOrDiamond');
        const ta = tad && kid(tad, 'typeArguments');
        const args = ta ? kids(kid(ta, 'typeArgumentList'), 'typeArgument').map(typeRef) : [];
        return ids.length ? { names: ids, args, dims: 0, diamond: !!(tad && kid(tad, 'diamond')) } : null;
      }
      return classTypeRef(n, 0);
    case 'typeArgument': {
      const rt = kid(n, 'referenceType');
      if (rt) { return typeRef(rt); }
      const w = kid(n, 'wildcard');
      const b = w && kid(w, 'wildcardBounds');
      return b && kid(b, 'Extends') ? typeRef(kid(b, 'referenceType')) : null;
    }
    case 'primitiveType': return { prim: primName(n), dims: 0 };
    case 'unannPrimitiveTypeWithOptionalDimsSuffix': return { prim: primName(n), dims: dimsCount(kid(n, 'dims')) };
    case 'result':
      if (kid(n, 'Void')) { return { prim: 'void', dims: 0 }; }
      return typeRef(kid(n, 'unannType'));
    case 'catchType': return typeRef(kid(n, 'unannClassType'));
    default: return null;
  }
}

function withDims(ref, extra) {
  if (!ref || !extra) { return ref; }
  return { ...ref, dims: (ref.dims || 0) + extra };
}

// ── java.lang names (implicitly imported) ─────────────────────────────────────

const JAVA_LANG = new Set([
  'Object', 'String', 'StringBuilder', 'StringBuffer', 'CharSequence', 'Math', 'StrictMath', 'System',
  'Thread', 'Runnable', 'Integer', 'Long', 'Short', 'Byte', 'Character', 'Boolean', 'Float', 'Double',
  'Number', 'Void', 'Class', 'ClassLoader', 'Enum', 'Iterable', 'Comparable', 'Cloneable', 'Runtime',
  'Process', 'ProcessBuilder', 'Exception', 'RuntimeException', 'Error', 'Throwable',
  'IllegalArgumentException', 'IllegalStateException', 'NullPointerException',
  'ArrayIndexOutOfBoundsException', 'IndexOutOfBoundsException', 'ClassCastException',
  'NumberFormatException', 'UnsupportedOperationException', 'InterruptedException',
  'CloneNotSupportedException', 'ArithmeticException', 'SecurityException', 'OutOfMemoryError',
  'StackOverflowError', 'ClassNotFoundException', 'Override', 'Deprecated', 'SuppressWarnings',
  'FunctionalInterface', 'SafeVarargs', 'AutoCloseable', 'Appendable', 'Readable', 'ThreadLocal',
  'InheritableThreadLocal', 'Record', 'StackTraceElement', 'Package', 'ThreadGroup',
]);

// ── Type table ────────────────────────────────────────────────────────────────

let anonCounter = 0;

class ClassInfo {
  constructor(o) {
    this.key = o.key;              // fqn for named classes, '<outer>$<offset>' for anonymous / local
    this.simple = o.simple;        // simple name ('' for anonymous)
    this.kind = o.kind;            // 'class' | 'interface' | 'enum' | 'record' | 'anon'
    this.file = o.file;
    this.fileInfo = o.fileInfo;
    this.pkg = o.fileInfo.pkg;
    this.outer = o.outer || null;  // enclosing ClassInfo
    this.isStatic = !!o.isStatic;
    this.local = !!o.local;
    this.extendsRefs = o.extendsRefs || [];      // superclass (classes) / super-interfaces (interfaces)
    this.implementsRefs = o.implementsRefs || [];
    this.typeParams = o.typeParams || [];        // [{ name, bound: ref|null }]
    this.fields = new Map();       // name → { ref, owner }
    this.methods = new Map();      // name → [MethodInfo]
    this.ctors = [];               // [MethodInfo]
    this.memberTypes = new Map();  // simple → ClassInfo
    this.localTypes = new Map();   // simple → ClassInfo of local classes declared in its methods
    this._supers = null;           // resolved [ClassInfo|libType] (superclass first)
    this._resolvingSupers = false;
  }
}

class MethodInfo {
  constructor(o) {
    this.id = o.id; this.name = o.name; this.owner = o.owner;
    this.paramRefs = o.paramRefs; this.varargs = !!o.varargs; this.retRef = o.retRef || null;
    this.typeParams = o.typeParams || []; this.isStatic = !!o.isStatic;
    this._params = null; this._ret = undefined;
  }
}

function typeParamsOf(node) {
  const tps = kid(node, 'typeParameters');
  const list = tps && kid(tps, 'typeParameterList');
  return kids(list, 'typeParameter').map(tp => {
    const id = firstIdent(kid(tp, 'typeIdentifier'));
    const bound = kid(tp, 'typeBound');
    const ct = bound && kid(bound, 'classOrInterfaceType');
    return { name: id ? id.image : '?', bound: ct ? typeRef(ct) : null };
  });
}

function hasModifier(mods, tokenName) {
  return mods.some(m => kids(m, tokenName).length > 0);
}

function parseFileHeader(cst) {
  const info = { pkg: '', single: new Map(), wildcard: [], staticSingle: new Map(), staticWildcard: [], topLevel: new Map() };
  const ocu = kid(cst, 'ordinaryCompilationUnit');
  if (!ocu) { return info; }
  const pd = kid(ocu, 'packageDeclaration');
  if (pd) { info.pkg = kids(pd, 'Identifier').map(t => t.image).join('.'); }
  for (const imp of kids(ocu, 'importDeclaration')) {
    const ids = kids(kid(imp, 'packageOrTypeName'), 'Identifier').map(t => t.image);
    if (!ids.length) { continue; }
    const isStatic = !!kid(imp, 'Static');
    const isWildcard = !!kid(imp, 'Star');
    if (isStatic && isWildcard) { info.staticWildcard.push(ids.join('.')); }
    else if (isStatic) { info.staticSingle.set(ids[ids.length - 1], ids.slice(0, -1).join('.')); }
    else if (isWildcard) { info.wildcard.push(ids.join('.')); }
    else { info.single.set(ids[ids.length - 1], ids.join('.')); }
  }
  return info;
}

/**
 * Build the type table. `getCst(file)` returns the cached CST (or null).
 * Files are registered in ordinal path order, so a duplicate class name resolves the
 * same way whatever order the caller passes the files in.
 */
function createTable() {
  return {
    classes: [],                // every ClassInfo
    byFqn: new Map(),           // fqn → [ClassInfo]
    byPos: new Map(),           // `${file}:${offset}` of a class body → ClassInfo
    files: new Map(),           // file → fileInfo
    packages: new Set(),
    methodById: new Map(),
  };
}

/** Register one parsed file (called from the analyzer's definitions pass, same CST). */
function addFile(table, file, cst) {
  if (!cst) { return; }
  let fileInfo;
  try { fileInfo = parseFileHeader(cst); } catch { return; }
  fileInfo.file = file;
  table.files.set(file, fileInfo);
  table.packages.add(fileInfo.pkg);
  try { registerFile(table, file, fileInfo, cst); } catch { /* skip files that crash the walk */ }
}

/**
 * Make lookups independent of the order files were added: a class name declared twice
 * resolves the same way whatever order the caller passed the files in.
 */
function finalizeTable(table) {
  const ord = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const list of table.byFqn.values()) { list.sort((a, b) => ord(a.file, b.file)); }
  return table;
}

/** Build the type table on its own. `getCst(file)` returns the cached CST (or null). */
function buildTypeTable(files, getCst) {
  const table = createTable();
  for (const file of files) { addFile(table, file, getCst(file)); }
  return finalizeTable(table);
}

function registerFile(table, file, fileInfo, cst) {
  const ocu = kid(cst, 'ordinaryCompilationUnit');
  for (const td of kids(ocu, 'typeDeclaration')) {
    const decl = kid(td, 'classDeclaration') || kid(td, 'interfaceDeclaration');
    if (decl) { registerTypeDecl(table, file, fileInfo, decl, null, false); }
  }
}

function addClass(table, ci, bodyNode) {
  table.classes.push(ci);
  if (ci.kind !== 'anon' && !ci.local) {
    const list = table.byFqn.get(ci.key);
    if (list) { list.push(ci); } else { table.byFqn.set(ci.key, [ci]); }
  }
  if (bodyNode) { table.byPos.set(`${ci.file}:${startOf(bodyNode)}`, ci); }
}

/** classDeclaration | interfaceDeclaration → ClassInfo (recursively registers members). */
function registerTypeDecl(table, file, fileInfo, decl, outer, local) {
  const isInterfaceDecl = decl.name === 'interfaceDeclaration';
  const mods = kids(decl, isInterfaceDecl ? 'interfaceModifier' : 'classModifier');
  const ncd = kid(decl, 'normalClassDeclaration');
  const ed = kid(decl, 'enumDeclaration');
  const rd = kid(decl, 'recordDeclaration');
  const nid = kid(decl, 'normalInterfaceDeclaration');
  const atd = kid(decl, 'annotationTypeDeclaration');
  const inner = ncd || ed || rd || nid || atd;
  if (!inner) { return null; }
  const nameTok = firstIdent(kid(inner, 'typeIdentifier'));
  const simple = nameTok ? nameTok.image : '(anonymous)';
  const kind = ncd ? 'class' : ed ? 'enum' : rd ? 'record' : 'interface';
  let key;
  if (local) { key = `${outer ? outer.key : fileInfo.pkg}$${simple}@${startOf(decl)}`; }
  else if (outer) { key = `${outer.key}.${simple}`; }
  else { key = fileInfo.pkg ? `${fileInfo.pkg}.${simple}` : simple; }

  const extendsRefs = []; const implementsRefs = [];
  if (ncd) {
    const sc = kid(ncd, 'superclass');
    if (sc) { extendsRefs.push(typeRef(kid(sc, 'classType'))); }
    const si = kid(ncd, 'superinterfaces');
    for (const it of kids(kid(si, 'interfaceTypeList'), 'interfaceType')) { implementsRefs.push(typeRef(it)); }
  } else if (ed || rd) {
    const si = kid(inner, 'superinterfaces');
    for (const it of kids(kid(si, 'interfaceTypeList'), 'interfaceType')) { implementsRefs.push(typeRef(it)); }
  } else if (nid) {
    const ei = kid(nid, 'extendsInterfaces');
    for (const it of kids(kid(ei, 'interfaceTypeList'), 'interfaceType')) { extendsRefs.push(typeRef(it)); }
  }
  const ci = new ClassInfo({
    key, simple, kind, file, fileInfo, outer,
    isStatic: hasModifier(mods, 'Static') || kind !== 'class' || (outer && outer.kind === 'interface'),
    local, extendsRefs: extendsRefs.filter(Boolean), implementsRefs: implementsRefs.filter(Boolean),
    typeParams: typeParamsOf(inner),
  });
  if (ed) { ci.extendsRefs = []; ci.enumSuper = true; }
  const body = kid(inner, 'classBody') || kid(inner, 'enumBody') || kid(inner, 'interfaceBody')
    || kid(inner, 'recordBody') || kid(inner, 'annotationTypeBody');
  addClass(table, ci, body);
  if (outer && !local) { outer.memberTypes.set(simple, ci); }
  if (outer && local && !outer.localTypes.has(simple)) { outer.localTypes.set(simple, ci); }
  if (!outer && !local) { fileInfo.topLevel.set(simple, ci); }

  if (ed) {
    const eb = kid(ed, 'enumBody');
    for (const ec of kids(kid(eb, 'enumConstantList'), 'enumConstant')) {
      const id = kid(ec, 'Identifier');
      if (id) { ci.fields.set(id.image, { ref: { self: ci }, owner: ci, isStatic: true }); }
      const cb = kid(ec, 'classBody');
      if (cb) { registerAnon(table, file, fileInfo, cb, ci, null, ci); }
    }
    const ebd = kid(eb, 'enumBodyDeclarations');
    for (const cbd of kids(ebd, 'classBodyDeclaration')) { registerMember(table, file, fileInfo, cbd, ci); }
  } else if (rd) {
    const rh = kid(rd, 'recordHeader');
    for (const rc of kids(kid(rh, 'recordComponentList'), 'recordComponent')) {
      const id = kid(rc, 'Identifier');
      if (id) { ci.fields.set(id.image, { ref: typeRef(kid(rc, 'unannType')), owner: ci }); }
    }
    for (const rbd of kids(kid(rd, 'recordBody'), 'recordBodyDeclaration')) {
      const cbd = kid(rbd, 'classBodyDeclaration');
      if (cbd) { registerMember(table, file, fileInfo, cbd, ci); }
    }
  } else if (ncd) {
    for (const cbd of kids(body, 'classBodyDeclaration')) { registerMember(table, file, fileInfo, cbd, ci); }
  } else if (nid) {
    for (const imd of kids(body, 'interfaceMemberDeclaration')) { registerInterfaceMember(table, file, fileInfo, imd, ci); }
  }
  return ci;
}

function addField(ci, fieldDeclLike, isStatic) {
  const baseRef = typeRef(kid(fieldDeclLike, 'unannType'));
  for (const vd of kids(kid(fieldDeclLike, 'variableDeclaratorList'), 'variableDeclarator')) {
    const vid = kid(vd, 'variableDeclaratorId');
    const id = kid(vid, 'Identifier');
    if (id) { ci.fields.set(id.image, { ref: withDims(baseRef, dimsCount(kid(vid, 'dims'))), owner: ci, isStatic }); }
  }
}

function paramsOf(fpl) {
  const refs = []; let varargs = false; const names = [];
  for (const fp of kids(fpl, 'formalParameter')) {
    const reg = kid(fp, 'variableParaRegularParameter');
    const va = kid(fp, 'variableArityParameter');
    if (reg) {
      const vid = kid(reg, 'variableDeclaratorId');
      refs.push(withDims(typeRef(kid(reg, 'unannType')), dimsCount(kid(vid, 'dims'))));
      const id = kid(vid, 'Identifier'); names.push(id ? id.image : null);
    } else if (va) {
      refs.push(withDims(typeRef(kid(va, 'unannType')), 1));
      const id = kid(va, 'Identifier'); names.push(id ? id.image : null);
      varargs = true;
    }
  }
  return { refs, varargs, names };
}

function addMethod(table, ci, mi) {
  const list = ci.methods.get(mi.name);
  if (list) { list.push(mi); } else { ci.methods.set(mi.name, [mi]); }
  table.methodById.set(mi.id, mi);
}

function registerMethodDecl(table, file, fileInfo, md, ci, isInterface) {
  const header = kid(md, 'methodHeader');
  const decl = kid(header, 'methodDeclarator');
  const id = kid(decl, 'Identifier');
  if (!id) { return; }
  const { refs, varargs } = paramsOf(kid(decl, 'formalParameterList'));
  const mods = kids(md, isInterface ? 'interfaceMethodModifier' : 'methodModifier');
  const mi = new MethodInfo({
    id: `${file}::${id.image}::${id.startLine}`, name: id.image, owner: ci,
    paramRefs: refs, varargs, retRef: withDims(typeRef(kid(header, 'result')), dimsCount(kid(decl, 'dims'))),
    typeParams: typeParamsOf(header), isStatic: hasModifier(mods, 'Static'),
  });
  addMethod(table, ci, mi);
}

function registerMember(table, file, fileInfo, cbd, ci) {
  const cmd = kid(cbd, 'classMemberDeclaration');
  if (cmd) {
    const fd = kid(cmd, 'fieldDeclaration');
    if (fd) {
      addField(ci, fd, hasModifier(kids(fd, 'fieldModifier'), 'Static'));
      return;
    }
    const md = kid(cmd, 'methodDeclaration');
    if (md) { registerMethodDecl(table, file, fileInfo, md, ci, false); return; }
    const cd = kid(cmd, 'classDeclaration') || kid(cmd, 'interfaceDeclaration');
    if (cd) { registerTypeDecl(table, file, fileInfo, cd, ci, false); }
    return;
  }
  const ctor = kid(cbd, 'constructorDeclaration');
  if (ctor) {
    const decl = kid(ctor, 'constructorDeclarator');
    const id = kid(kid(decl, 'simpleTypeName'), 'Identifier') || firstIdent(kid(decl, 'simpleTypeName'));
    if (id) {
      const { refs, varargs } = paramsOf(kid(decl, 'formalParameterList'));
      const mi = new MethodInfo({ id: `${file}::constructor::${id.startLine}`, name: 'constructor', owner: ci, paramRefs: refs, varargs, retRef: null });
      ci.ctors.push(mi);
      table.methodById.set(mi.id, mi);
    }
    return;
  }
}

function registerInterfaceMember(table, file, fileInfo, imd, ci) {
  const cd = kid(imd, 'constantDeclaration');
  if (cd) { addField(ci, cd, true); return; }
  const md = kid(imd, 'interfaceMethodDeclaration');
  if (md) { registerMethodDecl(table, file, fileInfo, md, ci, true); return; }
  const td = kid(imd, 'classDeclaration') || kid(imd, 'interfaceDeclaration');
  if (td) { registerTypeDecl(table, file, fileInfo, td, ci, false); }
}

/** Anonymous class body: `new X(..) { body }` or an enum constant body. */
function registerAnon(table, file, fileInfo, classBody, outer, instantiatedRef, enumSuper) {
  const ci = new ClassInfo({
    key: `${outer ? outer.key : fileInfo.pkg}$${startOf(classBody)}`, simple: '', kind: 'anon', file, fileInfo, outer,
    extendsRefs: instantiatedRef ? [instantiatedRef] : [],
  });
  if (enumSuper) { ci.enumConstantOf = enumSuper; }
  anonCounter++;
  addClass(table, ci, classBody);
  for (const cbd of kids(classBody, 'classBodyDeclaration')) { registerMember(table, file, fileInfo, cbd, ci); }
  return ci;
}

/**
 * Anonymous and local classes live inside bodies, which pass 1 does not walk (that would
 * cost a second full traversal). The resolver registers them when its walk reaches them:
 * nothing can name an anonymous class, and a local class is only visible after its
 * declaration in the same body, which the walk has then already passed.
 */
function ensureAnon(table, file, classBody, outer, instantiatedRef) {
  const known = table.byPos.get(`${file}:${startOf(classBody)}`);
  if (known) { return known; }
  const fileInfo = table.files.get(file);
  return fileInfo ? registerAnon(table, file, fileInfo, classBody, outer, instantiatedRef) : null;
}

function ensureLocal(table, file, decl, outer) {
  const inner = kid(decl, 'normalClassDeclaration') || kid(decl, 'enumDeclaration') || kid(decl, 'recordDeclaration')
    || kid(decl, 'normalInterfaceDeclaration') || kid(decl, 'annotationTypeDeclaration');
  const body = inner && (kid(inner, 'classBody') || kid(inner, 'enumBody') || kid(inner, 'interfaceBody')
    || kid(inner, 'recordBody') || kid(inner, 'annotationTypeBody'));
  if (!body || table.byPos.has(`${file}:${startOf(body)}`)) { return; }
  const fileInfo = table.files.get(file);
  if (fileInfo) { registerTypeDecl(table, file, fileInfo, decl, outer, true); }
}

// ── Resolution of names and references ────────────────────────────────────────

function pickClass(table, fqn, fromFile) {
  const list = table.byFqn.get(fqn);
  if (!list || !list.length) { return null; }
  if (list.length === 1 || !fromFile) { return list[0]; }
  const same = list.find(c => c.file === fromFile);
  if (same) { return same; }
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  return list.find(c => c.file.startsWith(dir + '/')) || list[0];
}

/** Member type `name` of ci or of its project supertypes. */
function memberType(table, ci, name, seen) {
  if (!ci) { return null; }
  const direct = ci.memberTypes.get(name);
  if (direct) { return direct; }
  seen = seen || new Set();
  if (seen.has(ci)) { return null; }
  seen.add(ci);
  for (const s of supersOf(table, ci)) {
    if (s && s.k === 'c') { const m = memberType(table, s.cls, name, seen); if (m) { return m; } }
  }
  return null;
}

/** Local classes visible from ci (declared in ci's methods), by simple name. */
function localClass(table, ci, name) {
  return ci.localTypes.get(name) || null;
}

/** Type variable `name` visible from ci (its own or an enclosing class's). */
function typeVar(ci, name) {
  for (let c = ci; c; c = c.outer) {
    const tp = c.typeParams.find(t => t.name === name);
    if (tp) { return { tp, owner: c }; }
  }
  return null;
}

/**
 * Resolve a simple type name seen from class ci (or from a file when ci is null):
 * enclosing classes and their inherited member types, local classes, the file's own
 * top-level types, single-type imports, the own package, wildcard imports, java.lang.
 * Returns { k:'c', cls } | { k:'l', fqn } | null.
 */
function lookupTypeName(table, name, ci, fileInfo, skipSupersOf) {
  for (let c = ci; c; c = c.outer) {
    if (c.simple === name && c.kind !== 'anon') { return { k: 'c', cls: c }; }
    const m = c === skipSupersOf ? c.memberTypes.get(name) : memberType(table, c, name);
    if (m) { return { k: 'c', cls: m }; }
    const l = localClass(table, c, name);
    if (l) { return { k: 'c', cls: l }; }
  }
  fileInfo = fileInfo || (ci && ci.fileInfo);
  if (!fileInfo) { return null; }
  const top = fileInfo.topLevel.get(name);
  if (top) { return { k: 'c', cls: top }; }
  const single = fileInfo.single.get(name);
  if (single) {
    const pc = resolveFqn(table, single, fileInfo.file);
    return pc || { k: 'l', fqn: single };
  }
  const samePkg = pickClass(table, fileInfo.pkg ? `${fileInfo.pkg}.${name}` : name, fileInfo.file);
  if (samePkg) { return { k: 'c', cls: samePkg }; }
  let libWildcard = null;
  for (const w of fileInfo.wildcard) {
    const pc = resolveFqn(table, `${w}.${name}`, fileInfo.file);
    if (pc) { return pc; }
    if (!libWildcard && !table.packages.has(w) && !table.byFqn.has(w)) { libWildcard = w; }
  }
  if (JAVA_LANG.has(name)) { return { k: 'l', fqn: `java.lang.${name}` }; }
  if (libWildcard && /^[A-Z]/.test(name)) { return { k: 'l', fqn: `${libWildcard}.${name}` }; }
  return null;
}

/** A dotted name `a.b.C` or `a.b.C.Inner` → project class, or null. */
function resolveFqn(table, fqn, fromFile) {
  const direct = pickClass(table, fqn, fromFile);
  if (direct) { return { k: 'c', cls: direct }; }
  return null;
}

/**
 * Resolve an unresolved ref written inside class ci (methodTypeParams: the enclosing
 * method's type parameters, which erase to their bound or to unknown).
 */
function resolveRef(table, ref, ci, fileInfo, methodTypeParams, skipSupersOf) {
  if (!ref) { return null; }
  if (ref.self) { return { k: 'c', cls: ref.self, args: [], dims: 0 }; }
  if (ref.var) { return null; }
  if (ref.prim) { return { k: 'p', name: ref.prim, dims: ref.dims || 0 }; }
  const names = ref.names;
  if (!names || !names.length) { return null; }
  const dims = ref.dims || 0;
  // method or class type variable → bound (erasure) or unknown
  if (names.length === 1) {
    const mtp = methodTypeParams && methodTypeParams.find(t => t.name === names[0]);
    const ctp = !mtp && typeVar(ci, names[0]);
    const tp = mtp || (ctp && ctp.tp);
    if (tp) {
      if (!tp.bound) { return dims ? { k: 'l', fqn: 'java.lang.Object', args: [], dims } : null; }
      const b = resolveRef(table, tp.bound, ctp ? ctp.owner : ci, fileInfo, null, skipSupersOf);
      return b ? { ...b, dims: dims + (b.dims || 0), tvar: names[0] } : null;
    }
  }
  const args = (ref.args || []).map(a => resolveRef(table, a, ci, fileInfo, methodTypeParams));
  let t = lookupTypeName(table, names[0], ci, fileInfo, skipSupersOf);
  let i = 1;
  if (!t) {
    // package-qualified: a.b.C[.Inner]
    for (let j = 1; j < names.length && !t; j++) {
      const r = resolveFqn(table, names.slice(0, j + 1).join('.'), (fileInfo || (ci && ci.fileInfo) || {}).file);
      if (r) { t = r; i = j + 1; }
    }
    if (!t) {
      // library: lower-case package parts, then the class
      const firstUpper = names.findIndex(n => /^[A-Z]/.test(n));
      if (firstUpper <= 0) { return null; }
      return { k: 'l', fqn: names.join('.'), args, dims };
    }
  }
  for (; i < names.length; i++) {
    if (t.k === 'c') {
      const m = memberType(table, t.cls, names[i]);
      if (!m) { return null; }
      t = { k: 'c', cls: m };
    } else {
      t = { k: 'l', fqn: `${t.fqn}.${names[i]}` };
    }
  }
  return { ...t, args, dims };
}

/** Direct supertypes of ci, resolved: superclass first, then interfaces. */
function supersOf(table, ci) {
  if (ci._supers) { return ci._supers; }
  if (ci._resolvingSupers) { return []; }
  ci._resolvingSupers = true;
  const out = [];
  try {
    // Supertype names are resolved from the enclosing scope: the class's own inherited
    // member types are not visible there (and resolving them would recurse).
    const scope = ci.outer;
    const fi = ci.fileInfo;
    for (const r of ci.extendsRefs) {
      const t = resolveRef(table, r, scope, fi, null, null) || (ci.kind === 'anon' ? null : null);
      if (t && !(t.k === 'c' && t.cls === ci)) { out.push(t); }
    }
    if (ci.enumConstantOf) { out.push({ k: 'c', cls: ci.enumConstantOf, args: [], dims: 0 }); }
    if (ci.kind === 'enum') { out.push({ k: 'l', fqn: 'java.lang.Enum', args: [], dims: 0 }); }
    for (const r of ci.implementsRefs) {
      const t = resolveRef(table, r, scope, fi, null, null);
      if (t && !(t.k === 'c' && t.cls === ci)) { out.push(t); }
    }
  } finally { ci._resolvingSupers = false; }
  ci._supers = out;
  return out;
}

/** The superclass of ci (the anonymous class's instantiated type counts), or null. */
function superclassOf(table, ci) {
  const s = supersOf(table, ci);
  if (ci.kind === 'interface') { return null; }
  if (ci.extendsRefs.length || ci.enumConstantOf || ci.kind === 'enum') { return s[0] || null; }
  return null;
}

/** All project ancestors (BFS, nearest first, superclass chain before interfaces). */
function ancestors(table, ci) {
  if (ci._ancestors) { return ci._ancestors; }
  const out = []; const seen = new Set([ci]); let libSuper = null;
  const queue = [ci];
  while (queue.length) {
    const c = queue.shift();
    for (const s of supersOf(table, c)) {
      if (s.k === 'c') { if (!seen.has(s.cls)) { seen.add(s.cls); out.push(s.cls); queue.push(s.cls); } }
      else if (s.k === 'l' && !libSuper && !(c.kind === 'interface')) { libSuper = s.fqn; }
      else if (s.k === 'l' && !libSuper && c === ci) { libSuper = s.fqn; }
    }
  }
  ci._ancestors = out;
  ci._libSuper = libSuper;
  return out;
}

function libSuperOf(table, ci) {
  ancestors(table, ci);
  return ci._libSuper || null;
}

function isSubclass(table, sub, sup) {
  if (sub === sup) { return true; }
  return ancestors(table, sub).includes(sup);
}

/** Field `name` of ci or of an ancestor → { ref, owner } or null. */
function fieldOf(table, ci, name) {
  const f = ci.fields.get(name);
  if (f) { return f; }
  for (const a of ancestors(table, ci)) {
    const g = a.fields.get(name);
    if (g) { return g; }
  }
  return null;
}

function resolvedFieldType(table, f) {
  if (f._t === undefined) { f._t = resolveRef(table, f.ref, f.owner, f.owner.fileInfo, null); }
  return f._t;
}

function methodParams(table, m) {
  if (!m._params) {
    m._params = m.paramRefs.map(r => resolveRef(table, r, m.owner, m.owner.fileInfo, m.typeParams));
  }
  return m._params;
}

function methodReturn(table, m) {
  if (m._ret === undefined) { m._ret = resolveRef(table, m.retRef, m.owner, m.owner.fileInfo, m.typeParams); }
  return m._ret;
}

module.exports = {
  kids, kid, isTok, startOf, firstIdent, dimsCount, typeRef, withDims, JAVA_LANG,
  buildTypeTable, createTable, addFile, finalizeTable, lookupTypeName, resolveRef, resolveFqn, supersOf, superclassOf, ancestors, libSuperOf,
  isSubclass, ensureAnon, ensureLocal, fieldOf, resolvedFieldType, methodParams, methodReturn, paramsOf, ClassInfo, MethodInfo,
};
