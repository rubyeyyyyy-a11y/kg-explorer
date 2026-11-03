import type { EdgeBrief, NodeBrief } from "../types/kg";
import { discoverLayered, materializeLayered, type CandidateExplanation, type DiscoverySummary, type LayeredDiscoveryResult } from "./layeredDiscovery";
import type { DemoRelation, TopicData } from "./types";

export const CANVAS_NODE_BUDGET = 50;
export const CANVAS_EDGE_BUDGET = 140;
export const INITIAL_NODE_TARGET = 32;
export const EXPAND_BATCH_SIZE = 12;

export type GraphFilters = {
  entityTypes: Set<string>;
  relationCategories: Set<string>;
  relations: Set<string>;
};

export type LocalGraph = {
  nodeIds: number[];
  edgeIds: string[];
  hopById: Map<number, number>;
  nodeLimited: boolean;
  edgeLimited: boolean;
  nodeMeta?: Map<number, CandidateExplanation>;
  edgeMeta?: Map<string, EdgeBrief>;
  discovery?: DiscoverySummary;
  dropped?: LayeredDiscoveryResult["dropped"];
};

export type NeighborPreview = {
  total: number;
  visible: number;
  remaining: number;
  typeCounts: Array<{ name: string; count: number }>;
  relationCounts: Array<{ name: string; count: number }>;
};

export type ExpansionAvailability = NeighborPreview & {
  topicTotal: number;
  filteredOut: number;
  capacity: number;
  state: "available" | "all_visible" | "filtered" | "budget_full" | "no_topic_relations";
};

function compareNumber(left: number, right: number) {
  return left - right;
}

function eligibleRelations(topic: TopicData, filters: GraphFilters) {
  return topic.relations.filter((relation) =>
    (!filters.relationCategories.size || filters.relationCategories.has(relation.relation_category)) &&
    (!filters.relations.size || filters.relations.has(relation.relation)),
  );
}

function graphIndex(topic: TopicData, filters: GraphFilters) {
  const entities = new Map(topic.entities.map((entity) => [entity.id, entity]));
  const relations = eligibleRelations(topic, filters);
  const byNode = new Map<number, DemoRelation[]>();
  for (const relation of relations) {
    byNode.set(relation.source, [...(byNode.get(relation.source) ?? []), relation]);
    byNode.set(relation.target, [...(byNode.get(relation.target) ?? []), relation]);
  }
  return { entities, relations, byNode };
}

function otherEnd(relation: DemoRelation, nodeId: number) {
  return relation.source === nodeId ? relation.target : relation.source;
}

/** Runs the browser port of the original layered_multiseed discovery algorithm. */
export function buildLocalGraph(
  topic: TopicData,
  focusId: number,
  anchors: number[],
  filters: GraphFilters,
  hops: number,
  target = INITIAL_NODE_TARGET,
): LocalGraph {
  return discoverLayered(topic, focusId, anchors, filters, hops, Math.min(Math.max(target, 1), CANVAS_NODE_BUDGET), CANVAS_EDGE_BUDGET);
}

export function expandLocalGraph(
  topic: TopicData,
  current: LocalGraph,
  anchorId: number,
  filters: GraphFilters,
  allowedTypes: Set<string>,
  allowedEntityIds: Set<number> = new Set(),
): { graph: LocalGraph; added: number; available: number; atBudget: boolean } {
  const { entities, relations, byNode } = graphIndex(topic, filters);
  const retained = new Set(current.nodeIds);
  const direct = [...(byNode.get(anchorId) ?? [])]
    .map((relation) => ({ relation, id: otherEnd(relation, anchorId) }))
    .filter(({ id }) => {
      const entity = entities.get(id);
      return Boolean(entity) && !retained.has(id) &&
        (!filters.entityTypes.size || filters.entityTypes.has(entity!.entity_type)) &&
        (!allowedTypes.size || allowedTypes.has(entity!.entity_type)) &&
        (!allowedEntityIds.size || allowedEntityIds.has(id));
    })
    .sort((left, right) => {
      const degreeDiff = (byNode.get(right.id)?.length ?? 0) - (byNode.get(left.id)?.length ?? 0);
      return degreeDiff || compareNumber(left.id, right.id) || left.relation.id.localeCompare(right.relation.id);
    });
  const capacity = Math.max(0, CANVAS_NODE_BUDGET - retained.size);
  const additions = direct.slice(0, Math.min(EXPAND_BATCH_SIZE, capacity));
  for (const { id } of additions) retained.add(id);

  const visibleRelations = relations
    .filter((relation) => retained.has(relation.source) && retained.has(relation.target))
    .sort((left, right) => {
      const leftNew = Number(additions.some(({ id }) => left.source === id || left.target === id));
      const rightNew = Number(additions.some(({ id }) => right.source === id || right.target === id));
      return rightNew - leftNew || left.id.localeCompare(right.id);
    });
  return {
    graph: {
      nodeIds: [...retained],
      edgeIds: visibleRelations.slice(0, CANVAS_EDGE_BUDGET).map((relation) => relation.id),
      hopById: new Map([...current.hopById, ...additions.map(({ id }) => [id, (current.hopById.get(anchorId) ?? 0) + 1] as [number, number])]),
      nodeLimited: direct.length > additions.length || retained.size >= CANVAS_NODE_BUDGET,
      edgeLimited: visibleRelations.length > CANVAS_EDGE_BUDGET,
      nodeMeta: new Map<number, CandidateExplanation>([...(current.nodeMeta ?? []), ...additions.map(({ id }) => [id, { layer: "local" as const, priorityScore: 0, scoreBreakdown: { coverage_score: 0, path_score: 0, bridge_score: 0, relation_weight: 0, type_weight: 0, distance_penalty: 0, hub_penalty: 0, generic_hub_penalty: 0, total_score: 0, direct_seed_support_count: 0, path_pair_count: 0, is_valid_shared_bridge: false, is_generic_hub: false, generic_hub_reason: "" }, supportSeeds: [], matchedSeedPairs: [], minSeedDistance: (current.hopById.get(anchorId) ?? 0) + 1, localAnchorSeed: anchorId, observedDegree: byNode.get(id)?.length ?? 0, selection: "manual_expand" as const }] as [number, CandidateExplanation])]),
      edgeMeta: new Map(visibleRelations.slice(0, CANVAS_EDGE_BUDGET).map((relation) => [relation.id, { source: relation.source, target: relation.target, rank: relation.rank, relation: relation.relation, source_db: relation.source_db } satisfies EdgeBrief])),
      discovery: current.discovery,
      dropped: current.dropped,
    },
    added: additions.length,
    available: direct.length,
    atBudget: capacity === 0,
  };
}

export function previewNeighbors(topic: TopicData, nodeId: number, currentNodeIds: number[], filters: GraphFilters): NeighborPreview {
  const { entities, byNode } = graphIndex(topic, filters);
  const visible = new Set(currentNodeIds);
  const neighbors = new Map<number, DemoRelation[]>();
  for (const relation of byNode.get(nodeId) ?? []) {
    const id = otherEnd(relation, nodeId);
    const entity = entities.get(id);
    if (!entity || (filters.entityTypes.size && !filters.entityTypes.has(entity.entity_type))) continue;
    neighbors.set(id, [...(neighbors.get(id) ?? []), relation]);
  }
  const count = (items: string[]) => [...new Set(items)].map((name) => ({ name, count: items.filter((item) => item === name).length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const relations = [...neighbors.values()].flat();
  return {
    total: neighbors.size,
    visible: [...neighbors.keys()].filter((id) => visible.has(id)).length,
    remaining: [...neighbors.keys()].filter((id) => !visible.has(id)).length,
    typeCounts: count([...neighbors.keys()].map((id) => entities.get(id)!.entity_type)),
    relationCounts: count(relations.map((relation) => relation.relation)),
  };
}

export function inspectExpansionAvailability(topic: TopicData, nodeId: number, currentNodeIds: number[], filters: GraphFilters): ExpansionAvailability {
  const preview = previewNeighbors(topic, nodeId, currentNodeIds, filters);
  const topicTotal = previewNeighbors(topic, nodeId, currentNodeIds, { entityTypes: new Set(), relationCategories: new Set(), relations: new Set() }).total;
  const capacity = Math.max(0, CANVAS_NODE_BUDGET - currentNodeIds.length);
  const filteredOut = Math.max(0, topicTotal - preview.total);
  const state = topicTotal === 0 ? "no_topic_relations"
    : preview.total === 0 ? "filtered"
    : capacity === 0 && preview.remaining > 0 ? "budget_full"
    : preview.remaining === 0 ? "all_visible"
    : "available";
  return { ...preview, topicTotal, filteredOut, capacity, state };
}

export function materializeGraph(topic: TopicData, graph: LocalGraph, focusId: number, seedIds: number[]): { nodes: NodeBrief[]; edges: EdgeBrief[] } {
  if (graph.discovery?.rankingMode === "layered_multiseed" && graph.nodeMeta && graph.edgeMeta) return materializeLayered(topic, graph as LayeredDiscoveryResult, focusId, seedIds);
  const entities = new Map(topic.entities.map((entity) => [entity.id, entity]));
  const relationById = new Map(topic.relations.map((relation) => [relation.id, relation]));
  return {
    nodes: graph.nodeIds.map((id) => {
      const entity = entities.get(id)!;
      const hop = graph.hopById.get(id) ?? 99;
      return {
        id, label: entity.label, entity_type: entity.entity_type, source: entity.source,
        role: seedIds.includes(id) || id === focusId ? "seed" : "candidate",
        // Labels are deliberately reserved for the focus, seeds and direct neighbors.
        showLabel: id === focusId || seedIds.includes(id) || hop <= 1,
      } as NodeBrief;
    }),
    edges: graph.edgeIds.map((id) => relationById.get(id)).filter((relation): relation is DemoRelation => Boolean(relation)).map((relation) => ({
      source: relation.source, target: relation.target, rank: relation.rank, relation: relation.relation, source_db: relation.source_db,
    })),
  };
}
