import type { EdgeBrief, NodeBrief } from "../types/kg";
import type { DemoEntity, DemoRelation, TopicData } from "./types";

/** Browser port of backend/app/services/graph_discovery_service.py@d2e925a.
 * The adapter operates on one curated static topic, so its degree is the
 * filtered topic-subgraph degree rather than Nebula's complete-space degree. */
export const LAYER_BUDGET_WEIGHTS = { core: 20, shared: 30, local: 30, supplement: 10 } as const;
const LAYER_ORDER = { core: 0, shared: 1, local: 2, supplement: 3 } as const;
const TYPE_BUDGETS: Record<string, number> = { disease: 20, gene: 20, drug: 15, protein: 10, phenotype: 10, symptom: 8, anatomy: 7 };
const TYPE_WEIGHTS: Record<string, number> = { disease: 1, gene: 1, drug: .95, protein: .85, phenotype: .8, symptom: .7, anatomy: .65 };
const LAYER_BONUS: Record<Layer, number> = { core: 10000, shared: 7000, local: 4000, supplement: 1000 };
const GENERIC_LABELS = new Set(["disease", "human disease", "metabolic disease"]);

export type Layer = keyof typeof LAYER_ORDER;
export type DiscoveryFilters = { entityTypes: Set<string>; relationCategories: Set<string>; relations: Set<string> };
export type DroppedReason = "entity_filter" | "budget" | "type_budget" | "generic_hub" | "edge_budget";
export type ScoreBreakdown = {
  coverage_score: number; path_score: number; bridge_score: number; relation_weight: number; type_weight: number;
  distance_penalty: number; hub_penalty: number; generic_hub_penalty: number; total_score: number;
  direct_seed_support_count?: number; path_pair_count?: number; is_valid_shared_bridge?: boolean; is_generic_hub?: boolean; generic_hub_reason?: string;
};
export type CandidateExplanation = {
  layer: Layer; priorityScore: number; scoreBreakdown: ScoreBreakdown; supportSeeds: number[]; matchedSeedPairs: string[];
  minSeedDistance: number; localAnchorSeed: number | null; observedDegree: number; selection: "seed" | "ranked" | "manual_expand";
};
export type DiscoverySummary = {
  rankingMode: "layered_multiseed"; candidateCount: number; selectedCandidates: number; dropped: Record<DroppedReason, number>;
  layers: Record<Layer, number>; layerBudgets: Record<Layer, number>; nodeBudget: number; edgeBudget: number;
  bridgePairsFound: number; backboneEdges: number; staticSubsetDegree: true;
};
export type LayeredDiscoveryResult = {
  nodeIds: number[]; edgeIds: string[]; hopById: Map<number, number>; nodeMeta: Map<number, CandidateExplanation>;
  edgeMeta: Map<string, EdgeBrief>; dropped: Array<{ id: number; reason: DroppedReason }>; summary: DiscoverySummary;
  nodeLimited: boolean; edgeLimited: boolean;
};

type Support = { id: number; seeds: Set<number>; directSeeds: Set<number>; edges: DemoRelation[]; edgeIds: Set<string>; relations: Set<string>; pairs: Set<string>; minDistance: number; observedDegree: number; anchors: Map<number, number> };
type Candidate = { entity: DemoEntity; support: Support; layer: Layer; score: number; breakdown: ScoreBreakdown; generic: boolean; genericReason: string; anchor: number | null };
type DecoratedEdge = { relation: DemoRelation; role: "seed_candidate" | "candidate_candidate" | "seed_seed"; layer: Layer; score: number; supportSeeds: number[]; pathPair: string; backbone: boolean };

const round4 = (value: number) => Math.round(value * 10000) / 10000;
const normalize = (value: string | undefined) => (value ?? "").trim().toLowerCase();
const pair = (a: number, b: number) => a <= b ? `${a}-${b}` : `${b}-${a}`;
const entityTypeBudgetKey = (type: string) => Object.hasOwn(TYPE_BUDGETS, type) ? type : "other";
const relationKey = (relation: DemoRelation) => relation.id;
const layerSort = (left: Candidate, right: Candidate) => LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer]
  || right.score - left.score || right.support.seeds.size - left.support.seeds.size || left.support.minDistance - right.support.minDistance
  || normalize(left.entity.entity_type).localeCompare(normalize(right.entity.entity_type)) || left.entity.id - right.entity.id;

function eligible(topic: TopicData, filters: DiscoveryFilters) {
  return topic.relations.filter((relation) =>
    (!filters.relationCategories.size || filters.relationCategories.has(relation.relation_category))
    && (!filters.relations.size || filters.relations.has(relation.relation)));
}

function makeSupport(id: number): Support {
  return { id, seeds: new Set(), directSeeds: new Set(), edges: [], edgeIds: new Set(), relations: new Set(), pairs: new Set(), minDistance: 99, observedDegree: 0, anchors: new Map() };
}

function scaleLayerBudgets(candidateBudget: number): Record<Layer, number> {
  const result: Record<Layer, number> = { core: 0, shared: 0, local: 0, supplement: 0 };
  const remainder: Array<{ layer: Layer; value: number }> = [];
  let assigned = 0;
  (Object.keys(LAYER_BUDGET_WEIGHTS) as Layer[]).forEach((layer) => {
    const raw = candidateBudget * LAYER_BUDGET_WEIGHTS[layer] / 90;
    result[layer] = Math.floor(raw); assigned += result[layer]; remainder.push({ layer, value: raw - result[layer] });
  });
  remainder.sort((a, b) => b.value - a.value || LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
  for (let index = 0; index < candidateBudget - assigned; index += 1) result[remainder[index].layer] += 1;
  return result;
}

function score(layer: Layer, support: Support, seedCount: number, entityType: string, genericBoost: number) {
  const coverage = round4(support.seeds.size / Math.max(1, seedCount));
  const path = seedCount > 1 ? round4(support.pairs.size / Math.max(1, seedCount - 1)) : 0;
  const bridge = round4(Math.max(0, support.seeds.size - 1) / Math.max(1, seedCount - 1));
  const relationWeight = round4(Math.min(1.5, support.edges.length * .25 + support.relations.size * .15));
  const typeWeight = round4(TYPE_WEIGHTS[entityType] ?? .55);
  const distancePenalty = round4(Math.max(0, support.minDistance - 1));
  const hubPenalty = round4(Math.min(2, Math.max(0, support.observedDegree - 2) / 8));
  const total = round4(LAYER_BONUS[layer] + coverage * 1000 + path * 800 + bridge * 700 + relationWeight * 220 + typeWeight * 120 - distancePenalty * 180 - (hubPenalty + genericBoost) * 240);
  return { coverage_score: coverage, path_score: path, bridge_score: bridge, relation_weight: relationWeight, type_weight: typeWeight, distance_penalty: distancePenalty, hub_penalty: hubPenalty, generic_hub_penalty: genericBoost, total_score: total };
}

function edgeRole(source: number, target: number, seeds: Set<number>): DecoratedEdge["role"] {
  if (seeds.has(source) && seeds.has(target)) return "seed_seed";
  return seeds.has(source) || seeds.has(target) ? "seed_candidate" : "candidate_candidate";
}

function edgeBucket(edge: DecoratedEdge) {
  if (edge.role === "seed_seed") return -8;
  if (edge.backbone && edge.layer === "core") return -10;
  if (edge.backbone) return ({ core: -10, shared: -7, local: -6, supplement: -5 } as const)[edge.layer];
  return ({ core: -9, shared: -7, local: -6, supplement: -5 } as const)[edge.layer];
}

function shortestPath(source: number, target: number, hops: number, relations: DemoRelation[], queryScanLimit: number) {
  if (source === target) return { nodes: [source], edges: [] as DemoRelation[] };
  const depth = new Map<number, number>([[source, 0]]);
  const parents = new Map<number, Array<{ id: number; edge: DemoRelation }>>();
  let frontier = [source];
  for (let currentDepth = 1; currentDepth <= hops && frontier.length; currentDepth += 1) {
    const next = new Set<number>();
    const frontierSet = new Set(frontier);
    const batch = relations.filter((edge) => frontierSet.has(edge.source) || frontierSet.has(edge.target)).slice(0, queryScanLimit);
    for (const edge of batch) for (const node of [edge.source, edge.target]) {
      if (!frontierSet.has(node)) continue;
      const child = edge.source === node ? edge.target : edge.source;
      const previous = depth.get(child);
      if (previous === undefined) { depth.set(child, currentDepth); parents.set(child, [{ id: node, edge }]); next.add(child); }
      else if (previous === currentDepth) parents.get(child)?.push({ id: node, edge });
    }
    if (depth.get(target) === currentDepth) break;
    frontier = [...next];
  }
  if (!depth.has(target)) return null;
  // Matches the Python path ordering contract: shortest first, then node IDs, then edge identifiers.
  const candidates: Array<{ nodes: number[]; edges: DemoRelation[] }> = [];
  const visit = (node: number, nodes: number[], edges: DemoRelation[]) => {
    if (node === source) { candidates.push({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }); return; }
    for (const parent of (parents.get(node) ?? []).sort((a, b) => a.id - b.id || relationKey(a.edge).localeCompare(relationKey(b.edge)))) {
      if (depth.get(parent.id) === (depth.get(node) ?? 0) - 1) visit(parent.id, [...nodes, parent.id], [...edges, parent.edge]);
    }
  };
  visit(target, [target], []);
  // traversal_service uses a LIFO reconstruction stack; after its final path
  // ordering this returns the lexically last equal-depth route from the mock
  // adapter.  Keep that historical tie behaviour rather than inventing one.
  candidates.sort((a, b) => b.nodes.join(",").localeCompare(a.nodes.join(",")) || b.edges.map(relationKey).join(",").localeCompare(a.edges.map(relationKey).join(",")));
  return candidates[0] ?? null;
}

function addSupportEdge(support: Support, seed: number, relation: DemoRelation) {
  support.seeds.add(seed); support.directSeeds.add(seed); support.minDistance = Math.min(support.minDistance, 1); support.anchors.set(seed, (support.anchors.get(seed) ?? 0) + 1); support.observedDegree += 1;
  if (!support.edgeIds.has(relation.id)) { support.edgeIds.add(relation.id); support.edges.push(relation); }
  if (normalize(relation.relation)) support.relations.add(normalize(relation.relation));
}

export function discoverLayered(topic: TopicData, focusId: number, requestedSeeds: number[], filters: DiscoveryFilters, hops: number, maxNodes: number, maxEdges: number): LayeredDiscoveryResult {
  const entities = new Map(topic.entities.map((entity) => [entity.id, entity]));
  const seeds = [...new Set([focusId, ...requestedSeeds])].filter((id) => entities.has(id)).slice(0, 4);
  const seedSet = new Set(seeds); const relations = eligible(topic, filters);
  const candidateBudget = Math.max(0, maxNodes - seeds.length); const layerBudgets = scaleLayerBudgets(candidateBudget); const queryScanLimit = Math.max(maxEdges, Math.min(400, maxEdges * 4));
  const support = new Map<number, Support>(); const directSeedPairs = new Set<string>(); const decorated: DecoratedEdge[] = [];
  const seedEdges = relations.filter((relation) => seedSet.has(relation.source) || seedSet.has(relation.target)).slice(0, queryScanLimit);
  for (const relation of seedEdges) {
    if (seedSet.has(relation.source) && seedSet.has(relation.target)) { directSeedPairs.add(pair(relation.source, relation.target)); decorated.push({ relation, role: "seed_seed", layer: "core", score: 99999, supportSeeds: [relation.source, relation.target].sort((a, b) => a - b), pathPair: pair(relation.source, relation.target), backbone: true }); continue; }
    const seed = seedSet.has(relation.source) ? relation.source : relation.target;
    if (!seedSet.has(seed)) continue;
    const other = relation.source === seed ? relation.target : relation.source;
    const item = support.get(other) ?? makeSupport(other); addSupportEdge(item, seed, relation); support.set(other, item);
  }
  let bridgePairsFound = 0;
  for (let index = 0; index < seeds.length; index += 1) for (const target of seeds.slice(index + 1)) {
    const source = seeds[index]; const pairText = pair(source, target); if (directSeedPairs.has(pairText)) continue;
    const path = shortestPath(source, target, Math.max(1, Math.min(3, hops)), relations, queryScanLimit); if (!path) continue;
    bridgePairsFound += 1;
    path.nodes.forEach((id, position) => { if (seedSet.has(id)) return; const item = support.get(id) ?? makeSupport(id); item.seeds.add(source); item.seeds.add(target); item.pairs.add(pairText); item.minDistance = Math.min(item.minDistance, Math.min(position, path.nodes.length - position - 1)); support.set(id, item); });
    for (const relation of path.edges) {
      const role = edgeRole(relation.source, relation.target, seedSet);
      decorated.push({ relation, role, layer: "core", score: 90000 - path.edges.length * 100, supportSeeds: [source, target], pathPair: pairText, backbone: true });
      for (const id of [relation.source, relation.target]) if (!seedSet.has(id)) { const item = support.get(id)!; item.observedDegree += 1; if (normalize(relation.relation)) item.relations.add(normalize(relation.relation)); }
    }
  }
  const filteredDrops: number[] = []; const candidates: Candidate[] = [];
  for (const item of support.values()) {
    const entity = entities.get(item.id); if (!entity) continue; const entityType = normalize(entity.entity_type);
    if (filters.entityTypes.size && !filters.entityTypes.has(entity.entity_type)) { filteredDrops.push(item.id); continue; }
    const validShared = item.seeds.size >= 2 && (item.directSeeds.size >= 2 || (item.pairs.size > 0 && item.directSeeds.size >= 1));
    const genericReason = GENERIC_LABELS.has(normalize(entity.label)) ? "generic_label" : entityType === "disease" && normalize(entity.label).includes("disease") && item.observedDegree >= 6 && item.seeds.size <= 1 ? "generic_high_degree_type" : "";
    const suppressed = Boolean(genericReason) && item.pairs.size === 0 && !validShared;
    const layer: Layer = item.pairs.size > 0 ? "core" : validShared ? "shared" : suppressed ? "supplement" : "local";
    const breakdown = score(layer, item, seeds.length, entityType, suppressed ? 8 : 0);
    const anchor = [...item.anchors.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? [...item.seeds].sort((a, b) => a - b)[0] ?? null;
    candidates.push({ entity, support: item, layer, score: breakdown.total_score, breakdown: { ...breakdown, direct_seed_support_count: item.directSeeds.size, path_pair_count: item.pairs.size, is_valid_shared_bridge: validShared, is_generic_hub: Boolean(genericReason), generic_hub_reason: genericReason }, generic: suppressed, genericReason, anchor });
  }
  candidates.sort(layerSort);
  const selected: Candidate[] = []; const selectedIds = new Set<number>(); const typeRemaining: Record<string, number> = { ...TYPE_BUDGETS, other: Math.max(6, Math.min(12, Math.max(1, Math.floor(candidateBudget / 6))) )}; const typeBlocked = new Set<number>();
  const take = (items: Candidate[], count: number, typed: boolean) => {
    for (const item of items) { if (selected.length >= candidateBudget || count <= 0 || selectedIds.has(item.entity.id)) continue; const key = entityTypeBudgetKey(normalize(item.entity.entity_type)); if (typed && (typeRemaining[key] ?? 0) <= 0) { typeBlocked.add(item.entity.id); continue; } selected.push(item); selectedIds.add(item.entity.id); if (typed) typeRemaining[key] -= 1; count -= 1; }
  };
  const core = candidates.filter((item) => item.layer === "core"); let remaining = candidateBudget; let carry = 0;
  const coreDesired = Math.min(remaining, Math.max(layerBudgets.core + carry, core.length)); take(core, coreDesired, false); remaining -= selected.length; carry = Math.max(0, coreDesired - core.filter((item) => selectedIds.has(item.entity.id)).length);
  const limitPerType = (items: Candidate[], cap: number) => items.filter((item, _index, all) => all.filter((other) => normalize(other.entity.entity_type) === normalize(item.entity.entity_type)).sort(layerSort).indexOf(item) < cap).sort(layerSort);
  const shared = limitPerType(candidates.filter((item) => item.layer === "shared"), 20); const sharedDesired = Math.min(remaining, layerBudgets.shared + carry); const beforeShared = selected.length; take(shared, sharedDesired, true); remaining -= selected.length - beforeShared; carry = Math.max(0, sharedDesired - (selected.length - beforeShared));
  const locals = limitPerType(candidates.filter((item) => item.layer === "local"), 20); const localDesired = Math.min(remaining, layerBudgets.local + carry); const beforeLocal = selected.length;
  const floor = localDesired > 0 && seeds.length ? Math.max(1, Math.min(4, Math.floor(localDesired / seeds.length) || 1)) : 0;
  for (let turn = 0; turn < floor; turn += 1) for (const seed of seeds) take(locals.filter((item) => item.anchor === seed), 1, true);
  take(locals, Math.max(0, localDesired - (selected.length - beforeLocal)), true); remaining -= selected.length - beforeLocal; carry = Math.max(0, localDesired - (selected.length - beforeLocal));
  // The original implementation fills Supplement from unselected Local pool;
  // a generic-hub-suppressed candidate is intentionally not promoted back.
  const supplements = limitPerType(locals.filter((item) => !selectedIds.has(item.entity.id)).map((item) => {
    const nextBreakdown = score("supplement", item.support, seeds.length, normalize(item.entity.entity_type), 0);
    return { ...item, layer: "supplement" as Layer, score: nextBreakdown.total_score, breakdown: nextBreakdown };
  }), 6);
  take(supplements, Math.min(remaining, layerBudgets.supplement + carry), true);
  const candidateById = new Map(selected.map((item) => [item.entity.id, item]));
  for (const item of selected) for (const relation of item.support.edges) decorated.push({ relation, role: edgeRole(relation.source, relation.target, seedSet), layer: item.layer, score: item.score, supportSeeds: [...item.support.seeds].sort((a, b) => a - b), pathPair: "", backbone: item.layer === "core" || item.layer === "shared" });
  for (const relation of relations) {
    const source = candidateById.get(relation.source); const target = candidateById.get(relation.target); if (!source || !target) continue;
    const layer: Layer = source.layer === "core" && target.layer === "core" ? "core" : [source.layer, target.layer].every((value) => value === "core" || value === "shared") ? "shared" : source.layer === "local" && target.layer === "local" ? "local" : source.layer === "supplement" || target.layer === "supplement" ? "supplement" : "local";
    const shared = [...source.support.seeds].filter((id) => target.support.seeds.has(id)); const sameAnchor = source.layer === "local" && target.layer === "local" && source.anchor != null && source.anchor === target.anchor;
    if (!(layer === "core" || layer === "shared" || (layer === "local" && (sameAnchor || shared.length)) || (layer === "supplement" && shared.length))) continue;
    decorated.push({ relation, role: "candidate_candidate", layer, score: Math.max(source.score, target.score), supportSeeds: shared, pathPair: "", backbone: layer === "core" || layer === "shared" });
  }
  const uniqueEdges = new Map<string, DecoratedEdge>(); for (const edge of decorated) { const existing = uniqueEdges.get(edge.relation.id); if (!existing || edgeBucket(edge) < edgeBucket(existing) || (edgeBucket(edge) === edgeBucket(existing) && edge.score > existing.score)) uniqueEdges.set(edge.relation.id, edge); }
  const rolePriority = { seed_candidate: 0, candidate_candidate: 1, seed_seed: 2 } as const;
  const finalEdges = [...uniqueEdges.values()].sort((a, b) => edgeBucket(a) - edgeBucket(b) || rolePriority[a.role] - rolePriority[b.role] || b.score - a.score || a.relation.source - b.relation.source || a.relation.target - b.relation.target || Number(a.relation.rank) - Number(b.relation.rank) || a.relation.relation.localeCompare(b.relation.relation) || (a.relation.source_db ?? "").localeCompare(b.relation.source_db ?? "")).slice(0, maxEdges);
  const used = new Set<number>(seeds); finalEdges.forEach((edge) => { used.add(edge.relation.source); used.add(edge.relation.target); });
  const finalCandidates = selected.filter((item) => used.has(item.entity.id)).sort(layerSort); const nodeIds = [...seeds, ...finalCandidates.map((item) => item.entity.id)];
  const nodeMeta = new Map<number, CandidateExplanation>(); seeds.forEach((id) => nodeMeta.set(id, { layer: "core", priorityScore: 100000, scoreBreakdown: { coverage_score: 0, path_score: 0, bridge_score: 0, relation_weight: 0, type_weight: 0, distance_penalty: 0, hub_penalty: 0, generic_hub_penalty: 0, total_score: 100000, direct_seed_support_count: 0, path_pair_count: 0, is_valid_shared_bridge: false, is_generic_hub: false, generic_hub_reason: "" }, supportSeeds: [], matchedSeedPairs: [], minSeedDistance: 0, localAnchorSeed: null, observedDegree: 0, selection: "seed" }));
  finalCandidates.forEach((item) => nodeMeta.set(item.entity.id, { layer: item.layer, priorityScore: item.score, scoreBreakdown: item.breakdown, supportSeeds: [...item.support.seeds].sort((a, b) => a - b), matchedSeedPairs: [...item.support.pairs].sort(), minSeedDistance: item.support.minDistance, localAnchorSeed: item.anchor, observedDegree: item.support.observedDegree, selection: "ranked" }));
  // Python reports generic-hub suppression in budget stats but does not add it
  // to dropped_candidates; preserve that response contract.
  const dropped = [...filteredDrops.map((id) => ({ id, reason: "entity_filter" as const })), ...candidates.filter((item) => !selectedIds.has(item.entity.id) && !item.generic).map((item) => ({ id: item.entity.id, reason: (typeBlocked.has(item.entity.id) ? "type_budget" : "budget") as DroppedReason }))];
  const layers: Record<Layer, number> = { core: 0, shared: 0, local: 0, supplement: 0 }; finalCandidates.forEach((item) => { layers[item.layer] += 1; });
  const edgeMeta = new Map(finalEdges.map((edge) => [edge.relation.id, { source: edge.relation.source, target: edge.relation.target, rank: edge.relation.rank, relation: edge.relation.relation, source_db: edge.relation.source_db, role: edge.role, layer: edge.layer, priority_score: edge.score, seed_support_vids: edge.supportSeeds, path_pair: edge.pathPair, is_backbone: edge.backbone } satisfies EdgeBrief]));
  const hopById = new Map<number, number>(); for (const id of nodeIds) hopById.set(id, id === focusId ? 0 : nodeMeta.get(id)?.minSeedDistance ?? 1);
  const droppedCounts: Record<DroppedReason, number> = { entity_filter: 0, budget: 0, type_budget: 0, generic_hub: candidates.filter((item) => item.generic && !selectedIds.has(item.entity.id)).length, edge_budget: Math.max(0, uniqueEdges.size - finalEdges.length) }; dropped.forEach((item) => { droppedCounts[item.reason] += 1; });
  return { nodeIds, edgeIds: finalEdges.map((edge) => edge.relation.id), hopById, nodeMeta, edgeMeta, dropped, summary: { rankingMode: "layered_multiseed", candidateCount: candidates.length, selectedCandidates: finalCandidates.length, dropped: droppedCounts, layers, layerBudgets, nodeBudget: maxNodes, edgeBudget: maxEdges, bridgePairsFound, backboneEdges: finalEdges.filter((edge) => edge.backbone).length, staticSubsetDegree: true }, nodeLimited: Boolean(dropped.length), edgeLimited: uniqueEdges.size > finalEdges.length };
}

export function materializeLayered(topic: TopicData, result: LayeredDiscoveryResult, focusId: number, seedIds: number[]) {
  const entities = new Map(topic.entities.map((entity) => [entity.id, entity]));
  const nodes: NodeBrief[] = result.nodeIds.map((id) => { const entity = entities.get(id)!; const meta = result.nodeMeta.get(id)!; return { id, label: entity.label, entity_type: entity.entity_type, source: entity.source, role: seedIds.includes(id) || id === focusId ? "seed" : "candidate", layer: meta.layer, score: meta.priorityScore, priority_score: meta.priorityScore, min_seed_distance: meta.minSeedDistance, bridge_seed_count: meta.supportSeeds.length, local_anchor_seed: meta.localAnchorSeed, matched_seed_pairs: meta.matchedSeedPairs, seed_support_count: meta.supportSeeds.length, seed_support_vids: meta.supportSeeds, score_breakdown: meta.scoreBreakdown, showLabel: id === focusId || seedIds.includes(id) || meta.minSeedDistance <= 1 }; });
  return { nodes, edges: result.edgeIds.map((id) => result.edgeMeta.get(id)).filter((edge): edge is EdgeBrief => Boolean(edge)) };
}
