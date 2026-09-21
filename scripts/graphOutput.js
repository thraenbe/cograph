// graphOutput.js — the one place a node analyzer writes its result.
// A pathological repo (guava: 2.6 M edges, because a bare-name call is linked to
// every same-named definition) used to take the analyzer down inside
// JSON.stringify ("Invalid string length") or run V8 out of memory. The result
// is now size-checked first and any serialisation failure becomes one readable
// stderr line + exit code 3, which the extension surfaces as the analyzer status.
'use strict';

// ~250 bytes per edge on the wire → 1 M edges ≈ 250 MB, half the host's output cap.
const MAX_EDGES = 1000000;

function fail(message, io) {
  io.err.write(`CoGraph analyzer: ${message}\n`);
  io.setExitCode(3);
  return false;
}

/**
 * Returns true when the graph was written. Never throws.
 * `io` (tests) = { out, err, setExitCode }; defaults to the process streams.
 */
function writeGraph(graph, io) {
  io = {
    out: process.stdout, err: process.stderr,
    setExitCode: (code) => { process.exitCode = code; },
    ...(io || {}),
  };
  const stream = io.out;
  const nodes = graph.nodes ? graph.nodes.length : 0;
  const edges = graph.edges ? graph.edges.length : 0;
  if (edges > MAX_EDGES) {
    return fail(`graph too large (${edges} edges from ${nodes} definitions): too many ambiguous call names`, io);
  }
  let text;
  try {
    text = JSON.stringify(graph);
  } catch (err) {
    return fail(`graph too large to serialise (${edges} edges, ${nodes} definitions): ${err && err.message}`, io);
  }
  stream.write(text + '\n');
  return true;
}

module.exports = { writeGraph, MAX_EDGES };
