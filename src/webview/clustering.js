// clustering.js — cluster-based complexity reduction
// All functions are globals; loaded before main.js

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
    this.rank = new Map(ids.map((id) => [id, 0]));
  }

  find(x) {
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)));
    }
    return this.parent.get(x);
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;
    const rankX = this.rank.get(rx);
    const rankY = this.rank.get(ry);
    if (rankX < rankY) {
      this.parent.set(rx, ry);
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
    }
    return true;
  }
}

function computeImportanceScores(data) {
  // Build in-degree map
  const inDegree = {};
  data.nodes.forEach((n) => { inDegree[n.id] = 0; });
  data.edges.forEach((e) => {
    if (e.source === '::MAIN::0') return;
    if (e.target in inDegree) inDegree[e.target]++;
  });
  const maxInDegree = Math.max(1, ...Object.values(inDegree));

  // BFS from entry-point nodes (depth scoring)
  const entryPointIds = new Set(
    data.edges.filter((e) => e.source === '::MAIN::0').map((e) => e.target)
  );
  const adjOut = {};
  data.nodes.forEach((n) => { adjOut[n.id] = []; });
  data.edges.forEach((e) => {
    if (e.source === '::MAIN::0') return;
    if (adjOut[e.source]) adjOut[e.source].push(e.target);
  });

  const depth = {};
  const queue = [];
  data.nodes.forEach((n) => {
    if (entryPointIds.has(n.id)) {
      depth[n.id] = 0;
      queue.push(n.id);
    }
  });
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const nb of (adjOut[cur] || [])) {
      if (!(nb in depth)) {
        depth[nb] = depth[cur] + 1;
        queue.push(nb);
      }
    }
  }
  const maxDepth = Math.max(1, ...Object.values(depth));
  data.nodes.forEach((n) => {
    if (!(n.id in depth)) depth[n.id] = maxDepth + 1;
  });

  // Return a Map of nodeId -> score
  const scores = new Map();
  data.nodes.forEach((n) => {
    const id = n.id;
    const depthScore = 1 - Math.min(depth[id] ?? (maxDepth + 1), maxDepth + 1) / (maxDepth + 1);
    const inDegScore = (inDegree[id] ?? 0) / maxInDegree;
    scores.set(id, 0.4 * depthScore + 0.6 * inDegScore);
  });
  return scores;
}

function inferProjectName(data) {
  const files = data.nodes.map((n) => n.file).filter(Boolean);
  if (files.length === 0) return 'Project';
  const parts = files.map((f) => f.split(/[\\/]/));
  const minLen = Math.min(...parts.map((p) => p.length));
  let commonLen = 0;
  for (let i = 0; i < minLen; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) commonLen = i + 1;
    else break;
  }
  return commonLen > 0 ? parts[0][commonLen - 1] : 'Project';
}

function computeClusters(data, importanceScores, level) {
  const nodeIds = data.nodes.filter((n) => n.id !== '::MAIN::0').map((n) => n.id);
  const realEdges = data.edges.filter((e) => e.source !== '::MAIN::0');

  const uf = new UnionFind(nodeIds);

  // Neighbor-merge phase
  if (level > 0.001 && level < 0.999) {
    const fileById = new Map(data.nodes.map(n => [n.id, n.file]));
    const FILE_AFFINITY = 0.05;
    const sortedEdges = [...realEdges].sort((a, b) => {
      const sameFileA = fileById.get(a.source) && fileById.get(a.source) === fileById.get(a.target);
      const sameFileB = fileById.get(b.source) && fileById.get(b.source) === fileById.get(b.target);
      const scoreA = (importanceScores.get(a.source) ?? 0) + (importanceScores.get(a.target) ?? 0) - (sameFileA ? FILE_AFFINITY : 0);
      const scoreB = (importanceScores.get(b.source) ?? 0) + (importanceScores.get(b.target) ?? 0) - (sameFileB ? FILE_AFFINITY : 0);
      return scoreA - scoreB;
    });

    const maxMerges = Math.max(0, nodeIds.length - 1);
    const fraction = (0.999 - level) / 0.998; // 0 at level=0.999, 1 at level=0.001
    const mergeCount = Math.floor(fraction * maxMerges);

    let merged = 0;
    for (const edge of sortedEdges) {
      if (merged >= mergeCount) break;
      if (uf.union(edge.source, edge.target)) merged++;
    }
  }

  // Project phase: merge everything
  if (level <= 0.001 && nodeIds.length > 1) {
    for (let i = 1; i < nodeIds.length; i++) {
      uf.union(nodeIds[0], nodeIds[i]);
    }
  }

  // Build output maps
  const nodeToCluster = new Map();
  const clusterMembers = new Map();
  for (const id of nodeIds) {
    const rep = uf.find(id);
    nodeToCluster.set(id, rep);
    if (!clusterMembers.has(rep)) clusterMembers.set(rep, []);
    clusterMembers.get(rep).push(id);
  }

  return { nodeToCluster, clusterMembers };
}

function computeStructuralClusters(data, groupBy, level) {
  const nodeIds = data.nodes.filter(n => n.id !== '::MAIN::0').map(n => n.id);

  if (level <= 0.001 && nodeIds.length > 1) {
    const nodeToCluster = new Map(nodeIds.map(id => [id, nodeIds[0]]));
    const clusterMembers = new Map([[nodeIds[0], [...nodeIds]]]);
    return { nodeToCluster, clusterMembers, clusterLabels: null };
  }

  if (level >= 0.999) {
    const nodeToCluster = new Map(nodeIds.map(id => [id, id]));
    const clusterMembers = new Map(nodeIds.map(id => [id, [id]]));
    return { nodeToCluster, clusterMembers, clusterLabels: null };
  }

  // Step 1: compute base structural groups
  const nodeToGroup = new Map();
  const baseLabels = new Map();
  const nodeById = new Map(data.nodes.map(n => [n.id, n]));

  for (const id of nodeIds) {
    const n = nodeById.get(id);
    let groupKey, label;
    if (groupBy === 'class' && n.className) {
      groupKey = `${n.file ?? ''}::${n.className}`;
      label = n.className;
    } else if (groupBy === 'file' && n.file) {
      groupKey = n.file;
      label = n.file.split(/[\\/]/).pop();
    } else if (groupBy === 'folder' && n.file) {
      const parts = n.file.split(/[\\/]/);
      parts.pop();
      groupKey = parts.join('/') || '/';
      label = parts[parts.length - 1] || 'root';
    }
    if (!groupKey) groupKey = id;
    nodeToGroup.set(id, groupKey);
    if (!baseLabels.has(groupKey) && label && groupKey !== id) {
      baseLabels.set(groupKey, label);
    }
  }

  // Step 2: compute target cluster count (same aggressiveness as connectivity mode)
  const allGroupIds = [...new Set(nodeToGroup.values())];
  const N = allGroupIds.length;
  const fraction = (0.999 - level) / 0.998;
  const mergeCount = Math.floor(fraction * Math.max(0, N - 1));
  const targetCount = Math.max(1, N - mergeCount);

  // Step 3: merge groups by path-prefix similarity (Kruskal-style)
  const groupPathSegs = new Map(allGroupIds.map(g => {
    const pathKey = (groupBy === 'class' && g.includes('::')) ? g.split('::')[0] : g;
    return [g, pathKey.split(/[\\/]/)];
  }));

  const uf = new UnionFind(allGroupIds);
  const mergedLabels = new Map(baseLabels);

  if (targetCount < N) {
    const pairs = [];
    for (let i = 0; i < allGroupIds.length; i++) {
      for (let j = i + 1; j < allGroupIds.length; j++) {
        const p1 = groupPathSegs.get(allGroupIds[i]);
        const p2 = groupPathSegs.get(allGroupIds[j]);
        let sim = 0;
        const minLen = Math.min(p1.length, p2.length);
        while (sim < minLen && p1[sim] === p2[sim]) sim++;
        pairs.push([sim, allGroupIds[i], allGroupIds[j], p1]);
      }
    }
    pairs.sort((a, b) => b[0] - a[0]);

    let currentCount = N;
    for (const [sim, g1, g2, p1] of pairs) {
      if (currentCount <= targetCount) break;
      const r1 = uf.find(g1);
      const r2 = uf.find(g2);
      if (r1 === r2) continue;
      uf.union(r1, r2);
      currentCount--;
      const merged = uf.find(r1);
      if (sim > 0) {
        mergedLabels.set(merged, p1[sim - 1]);
      }
    }
  }

  // Step 4: build output maps
  const nodeToCluster = new Map();
  const clusterMembers = new Map();
  const clusterLabels = new Map();

  for (const id of nodeIds) {
    const group = nodeToGroup.get(id);
    const clusterId = uf.find(group);
    nodeToCluster.set(id, clusterId);
    if (!clusterMembers.has(clusterId)) {
      clusterMembers.set(clusterId, []);
      if (mergedLabels.has(clusterId)) clusterLabels.set(clusterId, mergedLabels.get(clusterId));
    }
    clusterMembers.get(clusterId).push(id);
  }

  return { nodeToCluster, clusterMembers, clusterLabels };
}

function inferClusterLabel(clusterId, members, level, importanceScores, nodeById, data) {
  const memberCount = members.length;
  if (level <= 0.001) return inferProjectName(data);
  const sortedMembers = [...members].sort(
    (a, b) => (importanceScores.get(b) ?? 0) - (importanceScores.get(a) ?? 0)
  );
  const topNode = nodeById.get(sortedMembers[0]);
  const topName = topNode ? topNode.name : sortedMembers[0];
  return memberCount === 1 ? topName : `${topName} +${memberCount - 1}`;
}

function buildClusterNodes(data, clusterResult, level, importanceScores, expandedClusters, degreeMap, entryPointIds, nodeById) {
  const { clusterMembers } = clusterResult;
  const elements = [];

  for (const [clusterId, members] of clusterMembers) {
    const memberCount = members.length;
    const rep = nodeById.get(clusterId);
    const isExpanded = expandedClusters.has(clusterId) && memberCount > 1;

    if (isExpanded) {
      for (const memberId of members) {
        const n = nodeById.get(memberId);
        if (!n) continue;
        const deg = degreeMap.get(memberId) ?? 0;
        elements.push({
          data: {
            id: memberId,
            label: n.name,
            _size: Math.max(6, 6 + Math.sqrt(deg) * 2.5),
            file: n.file,
            line: n.line,
            isEntryPoint: entryPointIds.has(memberId),
            isCluster: false,
            isSynthetic: false,
            memberCount: 1,
            gitStatus: n.gitStatus,
            language: n.language,
            className: n.className,
            classExtends: n.classExtends,
            classImplements: n.classImplements,
          },
        });
      }
    } else {
      const label = clusterResult.clusterLabels?.get(clusterId)
        ?? inferClusterLabel(clusterId, members, level, importanceScores, nodeById, data);
      const deg = memberCount === 1 ? (degreeMap.get(clusterId) ?? 0) : 0;
      const _size = memberCount === 1
        ? Math.max(6, 6 + Math.sqrt(deg) * 2.5)
        : 36 * Math.max(1, Math.log2(memberCount + 1));
      const isSynthetic = level <= 0.001;
      const isCluster = memberCount > 1 && level > 0.001;

      let languageBreakdown = null;
      if (memberCount > 1) {
        const langCounts = {};
        for (const memberId of members) {
          const n = nodeById.get(memberId);
          const lang = n?.language ?? 'unknown';
          langCounts[lang] = (langCounts[lang] ?? 0) + 1;
        }
        languageBreakdown = Object.entries(langCounts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([lang, count]) => ({ lang, fraction: count / memberCount }));
      }

      elements.push({
        data: {
          id: clusterId,
          label,
          _size,
          file: memberCount === 1 && rep ? rep.file : null,
          line: memberCount === 1 && rep ? rep.line : null,
          isEntryPoint: memberCount === 1 && entryPointIds.has(clusterId),
          isCluster,
          isSynthetic,
          memberCount,
          languageBreakdown,
          gitStatus: memberCount === 1 && rep ? rep.gitStatus : undefined,
          language: memberCount === 1 && rep ? rep.language : undefined,
          className: memberCount === 1 && rep ? rep.className : undefined,
          classExtends: memberCount === 1 && rep ? rep.classExtends : undefined,
          classImplements: memberCount === 1 && rep ? rep.classImplements : undefined,
        },
      });
    }
  }

  return elements;
}

function buildRenderedNodeMap(nodeToCluster, expandedClusters) {
  const nodeToRendered = new Map();
  for (const [nodeId, clusterId] of nodeToCluster) {
    nodeToRendered.set(nodeId, expandedClusters.has(clusterId) ? nodeId : clusterId);
  }
  return nodeToRendered;
}

function buildDeduplicatedEdges(realEdges, nodeToRendered) {
  const elements = [];
  const seenEdges = new Set();
  for (const edge of realEdges) {
    const src = nodeToRendered.get(edge.source);
    const tgt = nodeToRendered.get(edge.target);
    if (!src || !tgt || src === tgt) continue;
    const key = `${src}→${tgt}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      elements.push({ data: { source: src, target: tgt } });
    }
  }
  return elements;
}

function buildClusteredElements(data, clusterResult, level, importanceScores, expandedClusters = new Set(), degreeMap = new Map()) {
  const { nodeToCluster } = clusterResult;
  const entryPointIds = new Set(data.edges.filter(e => e.source === '::MAIN::0').map(e => e.target));
  const nodeById = new Map(data.nodes.map(n => [n.id, n]));
  const realEdges = data.edges.filter(e => e.source !== '::MAIN::0');
  const nodeElements = buildClusterNodes(data, clusterResult, level, importanceScores, expandedClusters, degreeMap, entryPointIds, nodeById);
  const nodeToRendered = buildRenderedNodeMap(nodeToCluster, expandedClusters);
  const edgeElements = buildDeduplicatedEdges(realEdges, nodeToRendered);
  return [...nodeElements, ...edgeElements];
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
if (typeof module !== 'undefined') {
  module.exports = { UnionFind, computeImportanceScores, computeClusters, computeStructuralClusters, buildClusteredElements, inferProjectName };
}
