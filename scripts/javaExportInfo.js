// javaExportInfo.js — Java facts for the Markdown export (`analyze_java.js --export-info`).
//
// The graph holds methods and calls. The export also needs what a reader of one class sees first:
// class cards (kind, modifiers, extends, implements, fields, Javadoc), method signatures and end
// lines, string literals that name a URL, an asset or a file, and for every call site the receiver
// and argument text as written. All of it comes from the CSTs the analyzer already parsed, in
// source order, with no type resolution: which call links where is javaResolve.js's job, and
// `joinSites` attaches the text to its site records.
//
// Ported from the research project's export stopgap (TU Dresden, 2026-11-04), which settled the
// field and literal rules on ApoGames.
'use strict';

/** String literals whose value ends like this count as asset references. */
const ASSET_EXT = /\.(png|gif|jpe?g|bmp|wav|mp3|ogg|mid|midi|ttf|txt|properties|xml|mar|rep|dat|lvl|csv|php|html?)$/i;
/** Calls and constructors whose first string argument names a file, resource or URL. */
const FILE_CALLS = new Set(['getResource', 'getResourceAsStream', 'read', 'File', 'FileInputStream', 'FileOutputStream',
  'FileReader', 'FileWriter', 'URL', 'openStream', 'getAudioInputStream', 'createFont', 'loadData', 'RandomAccessFile', 'PrintWriter']);
const CLASS_NODES = { normalClassDeclaration: 'class', normalInterfaceDeclaration: 'interface', enumDeclaration: 'enum',
  recordDeclaration: 'record', annotationInterfaceDeclaration: 'annotation' };
const JAVADOC_HOLDERS = new Set(['classBodyDeclaration', 'classMemberDeclaration', 'interfaceMemberDeclaration', 'typeDeclaration',
  'classDeclaration', 'interfaceDeclaration', 'annotationTypeMemberDeclaration', 'enumBodyDeclarations']);

/** Whitespace runs collapsed to one space, trimmed. */
const flat = (s) => s.replace(/\s+/g, ' ').trim();
/** Flattened text cut to `max` characters with an ellipsis. */
const oneLine = (s, max = 60) => { const t = flat(s); return t.length > max ? `${t.slice(0, max - 3)}...` : t; };

/** All children of a CST node in source order (the CST groups them by rule name). */
function children(n) {
  const kids = [];
  for (const k in n.children) { for (const c of n.children[k]) { kids.push(c); } }
  // Source order, so literal and site lists come out ordered.
  return kids.sort((a, b) => (a.location?.startOffset ?? a.startOffset ?? 0) - (b.location?.startOffset ?? b.startOffset ?? 0));
}

/** Facts of one file. `src` is the text the CST was parsed from. */
function fileFacts(file, src, cst) {
  /** Source text of a located CST node, '' otherwise. */
  const slice = (node) => (node && node.location ? src.slice(node.location.startOffset, node.location.endOffset + 1) : '');
  /** Modifier texts without the annotations. */
  const mods = (nodes) => (nodes ?? []).map((m) => flat(slice(m))).filter((m) => !m.startsWith('@'));
  /** Annotation texts among the modifier nodes. */
  const anns = (nodes) => (nodes ?? []).map((m) => flat(slice(m))).filter((m) => m.startsWith('@'));
  /** Parameter texts of a formalParameterList, as written. */
  const params = (fpl) => (fpl?.children?.formalParameter ?? []).map((p) => flat(slice(p)));
  /** Dotted identifier chain of a classType node (type arguments left out). */
  const typeName = (ct) => (ct?.children?.Identifier ?? []).map((t) => t.image).join('.');
  /** The Identifier (or Super) tokens of an fqnOrRefType chain, in order. */
  const fqnTokens = (fqn) => [fqn.children.fqnOrRefTypePartFirst?.[0], ...(fqn.children.fqnOrRefTypePartRest ?? [])]
    .map((p) => { const c = p?.children?.fqnOrRefTypePartCommon?.[0]?.children; return c?.Identifier?.[0] ?? c?.Super?.[0]; })
    .filter(Boolean);
  const classes = [];
  const literals = [];
  const methods = [];
  const methodById = new Map();
  const sites = [];
  const classStack = [];
  const methodStack = [];
  const stack = [];
  const fileArgTokens = new Set();

  /**
   * Javadoc of a declaration: the last `/**` comment leading the node or one of the declaration
   * wrappers above it, flattened to one line; '' when there is none.
   */
  function javadocOf(node) {
    const cands = [node];
    for (let i = stack.length - 1; i >= 0 && JAVADOC_HOLDERS.has(stack[i].name); i--) { cands.push(stack[i]); }
    let doc = null;
    for (const c of cands) { for (const cm of c.leadingComments ?? []) { if (cm.image.startsWith('/**')) { doc = cm; } } }
    if (!doc) { return ''; }
    return flat(doc.image.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split('\n').map((l) => l.replace(/^\s*\*(?!\/)/, '')).join(' '));
  }

  /**
   * Class card of a type declaration node: name, kind, lines, outer class, modifiers, type
   * parameters, Javadoc, extends and implements as written (fields and literals are filled later).
   */
  function classCard(n, kind) {
    const c = n.children;
    const id = c.typeIdentifier?.[0]?.children?.Identifier?.[0];
    const parent = stack[stack.length - 1];
    const card = {
      name: id ? id.image : '(anonymous)', kind, line: id ? id.startLine : n.location.startLine, endLine: n.location.endLine,
      outer: classStack.length ? classStack[classStack.length - 1].name : '',
      modifiers: mods(parent?.children?.classModifier ?? parent?.children?.interfaceModifier),
      typeParams: c.typeParameters ? flat(slice(c.typeParameters[0])) : '', javadoc: javadocOf(n),
      extends: c.superclass ? typeName(c.superclass[0].children.classType?.[0]) : '', implements: [], fields: [], literals: [],
    };
    const list = c.superinterfaces?.[0]?.children?.interfaceTypeList?.[0] ?? c.extendsInterfaces?.[0]?.children?.interfaceTypeList?.[0];
    for (const it of list?.children?.interfaceType ?? []) { card.implements.push(typeName(it.children.classType?.[0])); }
    return card;
  }

  /** Add every declarator of a field or constant declaration to the current class card. */
  function field(n) {
    const c = n.children;
    const cls = classStack[classStack.length - 1];
    if (!cls) { return; }
    const m = mods(c.fieldModifier ?? c.constantModifier);
    const type = oneLine(slice(c.unannType?.[0]), 80);
    for (const d of c.variableDeclaratorList?.[0]?.children?.variableDeclarator ?? []) {
      const vid = d.children.variableDeclaratorId?.[0];
      const nm = vid?.children?.Identifier?.[0];
      if (!nm) { continue; }
      const init = d.children.variableInitializer ? oneLine(slice(d.children.variableInitializer[0]), 120) : '';
      cls.fields.push({ line: nm.startLine, modifiers: m.join(' '), type, name: nm.image + (vid.children.dims ? '[]' : ''), init });
    }
  }

  /**
   * Signature text, modifiers, annotations and abstractness of a method or constructor
   * declaration; a bodiless interface method that is neither default nor static counts as abstract.
   */
  function signature(name, n) {
    const c = n.children;
    const cls = classStack[classStack.length - 1];
    if (n.name === 'constructorDeclaration') {
      const d = c.constructorDeclarator[0].children;
      const m = mods(c.constructorModifier);
      const text = [...m, d.typeParameters ? flat(slice(d.typeParameters[0])) : '',
        `${cls ? cls.name : name}(${params(d.formalParameterList?.[0]).join(', ')})`, c.throws ? flat(slice(c.throws[0])) : '']
        .filter(Boolean).join(' ');
      return { signature: text, modifiers: m, annotations: anns(c.constructorModifier), abstract: false };
    }
    const modNodes = c.methodModifier ?? c.interfaceMethodModifier;
    const h = c.methodHeader[0].children;
    const d = h.methodDeclarator[0].children;
    const m = mods(modNodes);
    const text = [...m, h.typeParameters ? flat(slice(h.typeParameters[0])) : '', flat(slice(h.result[0])),
      `${d.Identifier[0].image}(${params(d.formalParameterList?.[0]).join(', ')})${d.dims ? flat(slice(d.dims[0])) : ''}`,
      h.throws ? flat(slice(h.throws[0])) : ''].filter(Boolean).join(' ');
    const bodyless = !c.methodBody?.[0]?.children?.block;
    const isAbstract = m.includes('abstract')
      || (n.name === 'interfaceMethodDeclaration' && bodyless && !m.includes('default') && !m.includes('static'));
    return { signature: text, modifiers: m, annotations: anns(modNodes), abstract: isAbstract };
  }

  /** Open a method or constructor: record its facts under the analyzer's id and make it the current caller. */
  function enterMethod(name, tok, n) {
    const id = `${file}::${name}::${tok.startLine}`;
    const m = { id, endLine: n.location.endLine, javadoc: javadocOf(n), ...signature(name, n), reads: [] };
    methods.push(m);
    methodById.set(id, m);
    methodStack.push(id);
  }

  /** Mark the first string literal inside the first argument of a file, resource or URL call. */
  function markFileArg(argList) {
    const todo = [argList?.children?.expression?.[0]];
    while (todo.length) {
      const x = todo.pop();
      if (!x) { continue; }
      if (x.tokenType && x.tokenType.name === 'StringLiteral') { fileArgTokens.add(x); return; }
      if (x.children) { for (const k in x.children) { todo.push(...x.children[k]); } }
    }
  }

  /** Record a call or `new` site with its receiver and argument text; sites outside a method are dropped. */
  function site(tok, kind, receiver, name, argNode, anonymous = false) {
    if (!methodStack.length) { return; }
    sites.push({ line: tok.startLine, col: tok.startColumn, kind, receiver, name, args: oneLine(slice(argNode)),
      caller: methodStack[methodStack.length - 1], anonymous });
  }

  /**
   * A `primary` chain: records every method call and `new` in it with the receiver text as
   * written, a `Class.CONSTANT` prefix as a candidate static read, and the file arguments.
   */
  function primary(n) {
    const pre = n.children.primaryPrefix?.[0];
    if (!pre) { return; }
    const start = n.location.startOffset;
    let last = null;
    if (pre.children.fqnOrRefType) {
      const chain = fqnTokens(pre.children.fqnOrRefType[0]);
      last = chain[chain.length - 1] ?? null;
      // `Class.CONSTANT` (also inside `Class.CONSTANT.m()`): a candidate static read. Whether
      // `Class` is a project class is only known across files, so the export filters these.
      const firstIsCall = !!n.children.primarySuffix?.[0]?.children?.methodInvocationSuffix;
      const method = methodById.get(methodStack[methodStack.length - 1]);
      if (method && chain.length - (firstIsCall ? 2 : 1) >= 1 && /^[A-Z]/.test(chain[0].image)
        && /^[A-Z_][A-Z0-9_]*$/.test(chain[1].image)) {
        const read = `${chain[0].image}.${chain[1].image}`;
        if (!method.reads.includes(read)) { method.reads.push(read); }
      }
    } else if (pre.children.newExpression) {
      const u = pre.children.newExpression[0].children.unqualifiedClassInstanceCreationExpression?.[0];
      const t = u?.children?.classOrInterfaceTypeToInstantiate?.[0];
      const first = t?.children?.Identifier?.[0];
      if (u && first) {
        const tName = (t.children.Identifier ?? []).map((x) => x.image).join('.');
        site(first, 'new', '', tName, u.children.argumentList?.[0], !!u.children.classBody);
        if (FILE_CALLS.has(tName.split('.').pop())) { markFileArg(u.children.argumentList?.[0]); }
      }
    }
    for (const s of n.children.primarySuffix ?? []) {
      if (s.children.Identifier) { last = s.children.Identifier[0]; continue; }
      if (s.children.methodInvocationSuffix) {
        if (last) {
          const receiver = src.slice(start, last.startOffset).replace(/[\s.]+$/, '');
          const argNode = s.children.methodInvocationSuffix[0].children.argumentList?.[0];
          site(last, 'call', oneLine(receiver), last.image, argNode);
          if (FILE_CALLS.has(last.image)) { markFileArg(argNode); }
        }
        last = null;
        continue;
      }
      last = null; // array access, class literal, method reference
    }
  }

  /** A string literal naming a URL, an asset or a file argument: record it on its class and with its owner. */
  function literal(tok) {
    const v = tok.image.slice(1, -1);
    const why = /^https?:\/\//i.test(v) ? 'url' : ASSET_EXT.test(v) ? 'asset' : fileArgTokens.has(tok) ? 'file-arg' : null;
    if (!why) { return; }
    const cls = classStack[classStack.length - 1];
    if (cls) { cls.literals.push({ line: tok.startLine, why, text: tok.image }); }
    // Owner: the method the literal sits in, else its class, else the file.
    literals.push({ file, line: tok.startLine, why, text: tok.image, method: methodStack[methodStack.length - 1] ?? null, cls: cls ? cls.name : null });
  }

  /** Depth-first walk keeping the class and method stacks; string literals inside annotations are skipped. */
  function walk(n) {
    if (!n || typeof n !== 'object') { return; }
    if (n.tokenType) { if (n.tokenType.name === 'StringLiteral' && !stack.some((x) => x.name === 'annotation')) { literal(n); } return; }
    let pushedClass = false;
    let pushedMethod = false;
    if (CLASS_NODES[n.name]) {
      const card = classCard(n, CLASS_NODES[n.name]);
      classes.push(card); classStack.push(card); pushedClass = true;
    } else if (n.name === 'fieldDeclaration' || n.name === 'constantDeclaration') {
      field(n);
    } else if (n.name === 'methodDeclaration' || n.name === 'interfaceMethodDeclaration') {
      const tok = n.children.methodHeader?.[0]?.children?.methodDeclarator?.[0]?.children?.Identifier?.[0];
      if (tok) { enterMethod(tok.image, tok, n); pushedMethod = true; }
    } else if (n.name === 'constructorDeclaration') {
      const tok = n.children.constructorDeclarator?.[0]?.children?.simpleTypeName?.[0]?.children?.Identifier?.[0];
      if (tok) { enterMethod('constructor', tok, n); pushedMethod = true; }
    } else if (n.name === 'primary') {
      primary(n);
    }
    if (n.children) {
      stack.push(n);
      for (const c of children(n)) { walk(c); }
      stack.pop();
    }
    if (pushedMethod) { methodStack.pop(); }
    if (pushedClass) { classStack.pop(); }
  }

  walk(cst);
  const pkgIds = cst?.children?.ordinaryCompilationUnit?.[0]?.children?.packageDeclaration?.[0]?.children?.Identifier ?? [];
  const pkg = pkgIds.map((t) => t.image).join('.');
  for (const c of classes) { c.file = file; c.pkg = pkg; }
  return { classes, methods, literals, sites: sites.map((s) => ({ file, ...s })) };
}

/** Explicit and implicit constructor invocations have no receiver text; they are named by form. */
const CTOR_FORMS = { 'ctor-super': 'super', 'ctor-this': 'this', 'ctor-super-implicit': 'super (implicit)' };

/**
 * Attach receiver and argument text to the resolver's site records, matched by file, line, column
 * and name (the resolver records the method name token, or the type name for `new`).
 */
function joinSites(resolverSites, textSites) {
  /** Position key of a site. */
  const key = (file, line, col, name) => `${file}\u0000${line}\u0000${col}\u0000${name}`;
  const byPos = new Map();
  for (const t of textSites) {
    const name = t.kind === 'new' ? '<init>' : t.name;
    byPos.set(key(t.file, t.line, t.col, name), t);
  }
  const used = new Set();
  const joined = resolverSites.map((s) => {
    const t = byPos.get(key(s.file, s.line, s.col, s.name));
    if (t) { used.add(t); }
    const ctor = CTOR_FORMS[s.form];
    return {
      file: s.file, line: s.line, col: s.col, caller: s.caller, form: s.form,
      name: ctor ?? (t && t.kind === 'new' ? `new ${t.name}` : s.name),
      receiver: t ? t.receiver : '', args: t ? t.args : '',
      targets: [...s.targets], reason: s.reason,
    };
  });
  // Sites the parser sees but the resolver does not record (an anonymous class of a library type,
  // `new Thread(r) { .. }`) are listed too, without an edge, so the report covers every site.
  for (const t of textSites) {
    if (used.has(t) || !t.caller) { continue; }
    joined.push({
      file: t.file, line: t.line, col: t.col, caller: t.caller, form: t.kind === 'new' ? 'new' : 'unrecorded',
      name: t.kind === 'new' ? `new ${t.name}` : t.name, receiver: t.receiver, args: t.args,
      targets: [], reason: t.anonymous ? 'anonymous-class' : 'not-recorded',
    });
  }
  return joined;
}

module.exports = { fileFacts, joinSites, ASSET_EXT, FILE_CALLS };
