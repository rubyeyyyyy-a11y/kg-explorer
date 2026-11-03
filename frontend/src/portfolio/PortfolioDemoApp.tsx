import { useEffect, useMemo, useRef, useState } from "react";
import { GraphCanvas } from "../components/GraphCanvas";
import { buildGraphRenderPatch, buildIncrementalNodePosition, createGraphRenderMutation, deriveGraphLayoutPlan } from "../graph/renderControl";
import { useGraphViewModel } from "../hooks/useGraphViewModel";
import type { EdgeBrief } from "../types/kg";
import { edgeKey } from "../utils/kg";
import { loadIndex, loadManifest, loadTopic } from "./data";
import {
  CANVAS_EDGE_BUDGET, CANVAS_NODE_BUDGET, buildLocalGraph, expandLocalGraph,
  inspectExpansionAvailability, materializeGraph, type ExpansionAvailability, type GraphFilters, type LocalGraph,
} from "./researchTrail";
import type { DemoEntity, DemoEvidence, DemoRelation, Manifest, TopicData } from "./types";
import ResearcherDataWorkspace from "./ResearcherDataWorkspace";
import "./portfolio.css";

type TrailStep = {
  id: number;
  topicId: string;
  focusId: number;
  previousFocusId: number | null;
  selectedNodeId: number | null;
  filters: { entityTypes: string[]; relationCategories: string[]; relations: string[]; hops: number };
  nodeIds: number[];
  edgeIds: string[];
  hops: Array<[number, number]>;
  positions: Record<string, { x: number; y: number }>;
  isRerooted: boolean;
  seedIds: number[];
};

type PendingFocus = {
  focusId: number;
  expectedNodeIds: number[];
  expectedEdgeIds: string[];
  structureChanged: boolean;
  empty: boolean;
};

const EMPTY_FILTERS: GraphFilters = { entityTypes: new Set(), relationCategories: new Set(), relations: new Set() };

function colorFor(type: string) {
  const hues = ["#dff0ff", "#e4f7e7", "#fff2d8", "#f5e7ff", "#fde7eb", "#e8eefc"];
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return { fill: hues[Math.abs(hash) % hues.length], stroke: "#5f7187" };
}

function cloneFilters(filters: GraphFilters) {
  return { entityTypes: new Set(filters.entityTypes), relationCategories: new Set(filters.relationCategories), relations: new Set(filters.relations) };
}

function filtersForTrail(filters: GraphFilters, hops: number): TrailStep["filters"] {
  return { entityTypes: [...filters.entityTypes], relationCategories: [...filters.relationCategories], relations: [...filters.relations], hops };
}

function filtersFromTrail(step: TrailStep): GraphFilters {
  return { entityTypes: new Set(step.filters.entityTypes), relationCategories: new Set(step.filters.relationCategories), relations: new Set(step.filters.relations) };
}

function EvidenceReferences({ evidence, rawEvidence, scope }: { evidence: DemoEvidence[]; rawEvidence?: string; scope: "entity" | "relation" }) {
  const [expanded, setExpanded] = useState(false);
  if (!evidence.length && !rawEvidence) return <p className="detail-note">暂无可查阅文献。</p>;
  const visible = expanded ? evidence : evidence.slice(0, 24);
  return <div className="evidence-block" data-testid={`${scope}-evidence`}>
    {evidence.length > 0 && <><div className="evidence-links">{visible.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer"><span><b>{item.title || (item.pmid ? `PubMed PMID ${item.pmid}` : `DOI ${item.doi}`)}</b><small>{item.authors?.length ? `${item.authors.slice(0, 3).join(", ")}${item.authors.length > 3 ? " et al." : ""} · ` : ""}{item.journal || ""}{item.publication_date ? ` · ${item.publication_date}` : ""}</small></span><em>{item.pmid ? `PMID ${item.pmid}` : `DOI ${item.doi}`} ↗</em></a>)}</div>{evidence.length > 24 && <button className="text-button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起文献列表" : `查看全部 ${evidence.length} 篇文献`}</button>}</>}
    {rawEvidence && <details className="raw-evidence"><summary>查看原始证据记录</summary><p>{rawEvidence}</p></details>}
  </div>;
}

function entityName(entityById: Map<number, DemoEntity>, id: number | null) {
  if (id == null) return "—";
  return entityById.get(id)?.label ?? `#${id}`;
}

export default function PortfolioDemoApp() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [index, setIndex] = useState<DemoEntity[]>([]);
  const [topicId, setTopicId] = useState("");
  const [topic, setTopic] = useState<TopicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [seedIds, setSeedIds] = useState<number[]>([]);
  const [hops, setHops] = useState(2);
  const [filters, setFilters] = useState<GraphFilters>(EMPTY_FILTERS);
  const [relationQuery, setRelationQuery] = useState("");
  const [localGraph, setLocalGraph] = useState<LocalGraph | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [isRerooted, setIsRerooted] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeBrief | null>(null);
  const [expandTypes, setExpandTypes] = useState<Set<string>>(new Set());
  const [relatedDirection, setRelatedDirection] = useState<"all" | "outbound" | "inbound">("all");
  const [selectedRelatedIds, setSelectedRelatedIds] = useState<Set<number>>(new Set());
  const [trail, setTrail] = useState<TrailStep[]>([]);
  const [notice, setNotice] = useState("");
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [mutation, setMutation] = useState(() => createGraphRenderMutation("discovery", "initial_discovery"));
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const [g6Snapshot, setG6Snapshot] = useState({ nodeIds: [] as string[], edgeIds: [] as string[], positions: {} as Record<string, { x: number; y: number }>, transform: { x: 0, y: 0, zoom: 1 } });
  const [screen, setScreen] = useState<"topics" | "workspace">("topics");
  const [surface, setSurface] = useState<"explorer" | "data-workspace">("explorer");
  const [exploreOpen, setExploreOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [connectionsLimit, setConnectionsLimit] = useState(12);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [evidenceGroupsExpanded, setEvidenceGroupsExpanded] = useState(false);
  const pendingSeedRef = useRef<number | null>(null);
  const topicRequestRef = useRef(0);

  useEffect(() => {
    void Promise.all([loadManifest(), loadIndex()]).then(([nextManifest, nextIndex]) => {
      setManifest(nextManifest); setIndex(nextIndex); setTopicId(nextManifest.topics[0]?.id ?? "");
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "演示数据加载失败"));
  }, []);

  useEffect(() => {
    if (!topicId) return;
    const requestId = ++topicRequestRef.current;
    void Promise.resolve().then(() => {
      if (requestId !== topicRequestRef.current) return;
      setLoading(true); setTopic(null); setSelectedNodeId(null); setSelectedEdge(null); setTrail([]); setNotice("");
      return loadTopic(topicId);
    }).then((nextTopic) => {
      if (!nextTopic) return;
      if (requestId !== topicRequestRef.current) return;
      const pending = pendingSeedRef.current;
      pendingSeedRef.current = null;
      const nextSeeds = (pending && nextTopic.entities.some((entity) => entity.id === pending)
        ? [...nextTopic.metadata.recommended_seeds, pending] : nextTopic.metadata.recommended_seeds)
        .filter((id, position, all) => all.indexOf(id) === position).slice(0, 4);
      const nextFocus = pending && nextTopic.entities.some((entity) => entity.id === pending) ? pending : nextSeeds[0];
      const nextFilters = cloneFilters(EMPTY_FILTERS);
      setTopic(nextTopic); setSeedIds(nextSeeds); setFocusId(nextFocus ?? null); setIsRerooted(false); setFilters(nextFilters); setHops(2); setRelationQuery("");
      setLocalGraph(nextFocus == null ? null : buildLocalGraph(nextTopic, nextFocus, nextSeeds, nextFilters, 2));
      setNodePositions(new Map());
      setMutation(createGraphRenderMutation("discovery", "initial_discovery", 1, { anchorNodeId: nextFocus ? String(nextFocus) : null }));
    }).catch((reason: unknown) => {
      if (requestId === topicRequestRef.current) setError(reason instanceof Error ? reason.message : "主题数据加载失败");
    }).finally(() => {
      if (requestId === topicRequestRef.current) setLoading(false);
    });
  }, [topicId]);

  const activeRoots = useMemo(() => isRerooted ? [] : seedIds, [isRerooted, seedIds]);
  const activeSeedSet = useMemo(() => new Set([...activeRoots, ...(focusId == null ? [] : [focusId])]), [activeRoots, focusId]);
  const materialized = useMemo(() => topic && localGraph && focusId != null ? materializeGraph(topic, localGraph, focusId, activeRoots) : { nodes: [], edges: [] }, [topic, localGraph, focusId, activeRoots]);
  const entityById = useMemo(() => new Map(topic?.entities.map((entity) => [entity.id, entity]) ?? []), [topic]);
  // The inspector may intentionally describe a neighbour that is not on the
  // canvas yet. Graph visibility is not the source of truth for entity detail.
  const selectedNode = selectedNodeId == null ? null : entityById.get(selectedNodeId) ?? null;
  const selectedNodeExplanation = selectedNodeId == null ? null : localGraph?.nodeMeta?.get(selectedNodeId) ?? null;
  const activeTopic = manifest?.topics.find((item) => item.id === topicId);
  const topicNames = useMemo(() => new Map(manifest?.topics.map((item) => [item.id, item.name]) ?? []), [manifest]);
  const filteredSearch = useMemo(() => {
    const query = search.trim().toLowerCase();
    return !query ? [] : index.filter((entity) => `${entity.label} ${entity.entity_type} ${entity.id}`.toLowerCase().includes(query)).slice(0, 10);
  }, [index, search]);
  const relationOptions = useMemo(() => {
    const query = relationQuery.trim().toLowerCase();
    return [...new Set(topic?.relations.map((item) => item.relation) ?? [])].filter((relation) => !query || relation.toLowerCase().includes(query)).sort((a, b) => a.localeCompare(b)).slice(0, 80);
  }, [topic, relationQuery]);
  const neighborPreview = useMemo<ExpansionAvailability | null>(() => topic && selectedNodeId != null && localGraph ? inspectExpansionAvailability(topic, selectedNodeId, localGraph.nodeIds, filters) : null, [topic, selectedNodeId, localGraph, filters]);
  const relatedEntities = useMemo(() => {
    if (!topic || selectedNodeId == null) return [] as Array<{ entity: DemoEntity; relation: DemoRelation; direction: "outbound" | "inbound"; visible: boolean }>;
    const visibleIds = new Set(localGraph?.nodeIds ?? []);
    return topic.relations
      .filter((relation) => relation.source === selectedNodeId || relation.target === selectedNodeId)
      .map((relation) => {
        const direction = relation.source === selectedNodeId ? "outbound" as const : "inbound" as const;
        const entity = entityById.get(direction === "outbound" ? relation.target : relation.source);
        return entity ? { entity, relation, direction, visible: visibleIds.has(entity.id) } : null;
      })
      .filter((item): item is { entity: DemoEntity; relation: DemoRelation; direction: "outbound" | "inbound"; visible: boolean } => Boolean(item))
      .filter((item) => relatedDirection === "all" || item.direction === relatedDirection)
      .sort((left, right) => left.entity.label.localeCompare(right.entity.label) || left.relation.id.localeCompare(right.relation.id));
  }, [topic, selectedNodeId, localGraph, entityById, relatedDirection]);
  const selectedEdgeData = useMemo(() => selectedEdge && topic
    ? topic.relations.find((relation) => relation.source === selectedEdge.source && relation.target === selectedEdge.target && relation.rank === selectedEdge.rank) ?? null
    : null, [selectedEdge, topic]);
  const evidenceById = useMemo(() => new Map(topic?.evidence.map((item) => [item.id, item]) ?? []), [topic]);
  const selectedNodeEvidenceGroups = useMemo(() => {
    if (selectedNodeId == null || !topic) return [] as Array<{ relation: DemoRelation; evidence: DemoEvidence[] }>;
    return topic.relations
      .filter((relation) => relation.source === selectedNodeId || relation.target === selectedNodeId)
      .map((relation) => ({ relation, evidence: (relation.evidence_ids ?? []).map((id) => evidenceById.get(id)).filter((item): item is DemoEvidence => Boolean(item)) }))
      // Evidence belongs to a relationship.  A relation with only raw Evidence
      // still belongs in the node-level aggregate, even when it has no explicit
      // PMID/DOI link to render.
      .filter((item) => item.evidence.length > 0 || Boolean(item.relation.evidence_raw))
      .sort((left, right) => right.evidence.length - left.evidence.length || left.relation.id.localeCompare(right.relation.id));
  }, [selectedNodeId, topic, evidenceById]);
  const selectedNodeEvidence = useMemo(() => {
    const unique = new Map<string, DemoEvidence>();
    selectedNodeEvidenceGroups.forEach((group) => group.evidence.forEach((item) => unique.set(item.id, item)));
    return [...unique.values()];
  }, [selectedNodeEvidenceGroups]);
  const selectedEdgeEvidence = useMemo(() => (selectedEdgeData?.evidence_ids ?? []).map((id) => evidenceById.get(id)).filter((item): item is DemoEvidence => Boolean(item)), [selectedEdgeData, evidenceById]);
  const graph = useGraphViewModel({
    visibleGraphNodes: materialized.nodes, visibleGraphEdges: materialized.edges, rootVid: focusId,
    visibleNodeHopLevelMap: localGraph?.hopById ?? new Map(), activeSeedVidSet: activeSeedSet, graphSourceMode: "discovery",
    nodePositionById: nodePositions, discoveryTypeColor: colorFor, edgeLabelSelectedDisplays: [], edgeLabelSelectionTouched: false, edgeLabelKeyword: "",
  });
  // Portfolio exploration uses authoritative full G6 submissions. Avoid
  // reading or mutating a ref during render merely to derive an unused patch.
  const renderPatch = useMemo(() => buildGraphRenderPatch(null, graph.viewModel), [graph.viewModel]);
  const layoutPlan = useMemo(() => deriveGraphLayoutPlan(mutation), [mutation]);

  const snapshot = (): TrailStep | null => {
    if (!localGraph || focusId == null) return null;
    const positions: Record<string, { x: number; y: number }> = {};
    for (const id of localGraph.nodeIds) {
      const position = nodePositions.get(String(id));
      if (position) positions[String(id)] = position;
    }
    return { id: trail.length + 1, topicId, focusId, previousFocusId: trail.at(-1)?.focusId ?? null, selectedNodeId, filters: filtersForTrail(filters, hops), nodeIds: localGraph.nodeIds, edgeIds: localGraph.edgeIds, hops: [...localGraph.hopById.entries()], positions, isRerooted, seedIds };
  };

  const rebuild = (nextFilters = filters, nextHops = hops, nextSeeds = seedIds) => {
    if (!topic || focusId == null) return;
    setLocalGraph(buildLocalGraph(topic, focusId, nextSeeds, nextFilters, nextHops));
    setNotice("筛选已应用到当前焦点的本地真实关系。");
    setMutation(createGraphRenderMutation("discovery", "initial_discovery", mutation.sequence + 1, { anchorNodeId: String(focusId) }));
  };
  const updateFilters = (updater: (current: GraphFilters) => GraphFilters) => {
    const next = updater(filters); setFilters(next); rebuild(next);
  };

  const addSeed = (entity: DemoEntity) => {
    const category = entity.categories?.includes(topicId) ? topicId : entity.categories?.[0];
    if (!category) return;
    if (category !== topicId) { pendingSeedRef.current = entity.id; setTopicId(category); }
    else {
      const nextSeeds = seedIds.includes(entity.id) ? seedIds : [...seedIds, entity.id].slice(-4);
      setSeedIds(nextSeeds); rebuild(filters, hops, nextSeeds);
    }
    setSearch("");
  };
  const selectNode = (id: number) => { setSelectedNodeId(id); setSelectedEdge(null); setExpandTypes(new Set()); setSelectedRelatedIds(new Set()); setDescriptionExpanded(false); setEvidenceGroupsExpanded(false); setConnectionsLimit(12); setExploreOpen(false); setNotice(""); };
  const centerOnSelected = () => {
    if (!topic || selectedNodeId == null || focusId == null) return;
    const current = snapshot(); if (current) setTrail((items) => [...items, current]);
    // Rerooting deliberately does not retain the previous focus or every Seed as
    // traversal anchors.  The selected node is the only default start point.
    const next = buildLocalGraph(topic, selectedNodeId, [], filters, hops);
    const sameNodes = next.nodeIds.length === localGraph?.nodeIds.length && next.nodeIds.every((id) => localGraph?.nodeIds.includes(id));
    const sameEdges = next.edgeIds.length === localGraph?.edgeIds.length && next.edgeIds.every((id) => localGraph?.edgeIds.includes(id));
    const nextRenderedEdges = materializeGraph(topic, next, selectedNodeId, []).edges.map(edgeKey);
    setPendingFocus({ focusId: selectedNodeId, expectedNodeIds: next.nodeIds, expectedEdgeIds: nextRenderedEdges, structureChanged: !(sameNodes && sameEdges), empty: next.nodeIds.length <= 1 });
    setLocalGraph(next); setFocusId(selectedNodeId); setIsRerooted(true); setNodePositions(new Map());
    setNotice("正在提交新的局部图谱并重新布局…");
    setMutation(createGraphRenderMutation("discovery", "initial_discovery", mutation.sequence + 1, { anchorNodeId: String(selectedNodeId) }));
  };
  const expandSelected = () => {
    if (!topic || !localGraph || selectedNodeId == null) return;
    const result = expandLocalGraph(topic, localGraph, selectedNodeId, filters, expandTypes, selectedRelatedIds);
    if (result.added === 0) {
      setNotice(result.atBudget ? "画布已达到 50 个节点上限。请切换焦点或移除非关键节点。" : "没有符合当前筛选条件、且尚未显示的真实邻居。");
      return;
    }
    const prior = new Set(localGraph.nodeIds);
    const newIds = result.graph.nodeIds.filter((id) => !prior.has(id));
    const anchor = nodePositions.get(String(selectedNodeId)) ?? { x: 0, y: 0 };
    setNodePositions((previous) => {
      const next = new Map(previous);
      newIds.forEach((id, position) => next.set(String(id), buildIncrementalNodePosition(anchor, String(selectedNodeId), String(id), position)));
      return next;
    });
    setLocalGraph(result.graph); setNotice(`已追加 ${result.added} 个真实关联节点；保留了当前画布布局。`);
    setMutation(createGraphRenderMutation("discovery", "expand", mutation.sequence + 1, { anchorNodeId: String(selectedNodeId), affectedNodeIds: newIds.map(String) }));
  };
  const restoreStep = (step: TrailStep, index: number) => {
    setTopicId(step.topicId);
    if (step.topicId !== topicId) return;
    const restoredFilters = filtersFromTrail(step);
    setFilters(restoredFilters); setHops(step.filters.hops); setSeedIds(step.seedIds); setFocusId(step.focusId); setIsRerooted(step.isRerooted); setSelectedNodeId(step.selectedNodeId); setSelectedEdge(null); setSelectedRelatedIds(new Set());
    setLocalGraph({ nodeIds: step.nodeIds, edgeIds: step.edgeIds, hopById: new Map(step.hops), nodeLimited: step.nodeIds.length >= CANVAS_NODE_BUDGET, edgeLimited: step.edgeIds.length >= CANVAS_EDGE_BUDGET });
    setNodePositions(new Map(Object.entries(step.positions))); setTrail((items) => items.slice(0, index));
    setNotice("已恢复此前的研究上下文与局部图谱。 ");
    setMutation(createGraphRenderMutation("discovery", "initial_discovery", mutation.sequence + 1, { anchorNodeId: String(step.focusId) }));
  };
  const goBack = () => { const step = trail.at(-1); if (step) restoreStep(step, trail.length - 1); };
  const toggleRelated = (id: number) => setSelectedRelatedIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const inspectRelation = (relation: DemoRelation) => {
    setSelectedEdge({ source: relation.source, target: relation.target, rank: relation.rank, relation: relation.relation, source_db: relation.source_db });
    setSelectedNodeId(null); setSelectedRelatedIds(new Set()); setExploreOpen(false);
  };
  const exploreSelectedRelated = () => {
    if (!topic || !selectedRelatedIds.size || focusId == null) return;
    const nextSeeds = [...selectedRelatedIds].filter((id) => entityById.has(id)).slice(0, 4);
    if (!nextSeeds.length) return;
    const current = snapshot(); if (current) setTrail((items) => [...items, current]);
    const nextFocus = nextSeeds[0];
    const next = buildLocalGraph(topic, nextFocus, nextSeeds, filters, hops);
    setPendingFocus({ focusId: nextFocus, expectedNodeIds: next.nodeIds, expectedEdgeIds: materializeGraph(topic, next, nextFocus, nextSeeds).edges.map(edgeKey), structureChanged: true, empty: next.nodeIds.length <= 1 });
    setSeedIds(nextSeeds); setFocusId(nextFocus); setIsRerooted(false); setSelectedNodeId(nextFocus); setLocalGraph(next); setNodePositions(new Map());
    setNotice(`正在以 ${nextSeeds.length} 个已选择关联实体构建 ${hops}-Hop 局部图谱…`);
    setMutation(createGraphRenderMutation("discovery", "initial_discovery", mutation.sequence + 1, { anchorNodeId: String(nextFocus) }));
  };
  const handleGraphRendered = (snapshot: { nodeIds: string[]; edgeIds: string[]; positions: Record<string, { x: number; y: number }>; transform: { x: number; y: number; zoom: number } }) => {
    setG6Snapshot((previous) => {
      const sameIds = previous.nodeIds.join(",") === snapshot.nodeIds.join(",") && previous.edgeIds.join(",") === snapshot.edgeIds.join(",");
      const positionsChanged = Object.keys(snapshot.positions).some((id) => {
        const old = previous.positions[id]; const next = snapshot.positions[id];
        return !old || Math.abs(old.x - next.x) > .5 || Math.abs(old.y - next.y) > .5;
      });
      const transformChanged = Math.abs(previous.transform.x - snapshot.transform.x) > .5 || Math.abs(previous.transform.y - snapshot.transform.y) > .5 || Math.abs(previous.transform.zoom - snapshot.transform.zoom) > .001;
      return sameIds && !positionsChanged && !transformChanged ? previous : snapshot;
    });
    if (!pendingFocus) return;
    const sameNodes = pendingFocus.expectedNodeIds.length === snapshot.nodeIds.length && pendingFocus.expectedNodeIds.every((id) => snapshot.nodeIds.includes(String(id)));
    const sameEdges = pendingFocus.expectedEdgeIds.length === snapshot.edgeIds.length && pendingFocus.expectedEdgeIds.every((id) => snapshot.edgeIds.includes(String(id)));
    if (!sameNodes || !sameEdges || !snapshot.nodeIds.includes(String(pendingFocus.focusId))) return;
    const label = entityById.get(pendingFocus.focusId)?.label ?? `#${pendingFocus.focusId}`;
    if (pendingFocus.empty) setNotice(`已切换到 ${label}；当前筛选/主题数据未收录可展示的真实关联。`);
    else if (!pendingFocus.structureChanged) setNotice(`已切换焦点到 ${label}；当前筛选下局部节点集合相同，已重新布局并居中。`);
    else setNotice(`已以 ${label} 为中心更新局部图谱并完成布局。`);
    setPendingFocus(null);
  };
  const expansionStatus = !neighborPreview ? "选择节点后可查看展开状态。"
    : neighborPreview.state === "available" ? `可追加约 ${Math.min(12, neighborPreview.remaining, neighborPreview.capacity)} 个真实未显示邻居。`
    : neighborPreview.state === "all_visible" ? "已显示全部符合当前筛选条件的关联。"
    : neighborPreview.state === "filtered" ? `该节点有 ${neighborPreview.filteredOut} 个真实邻居被当前实体/关系筛选隐藏；请调整筛选。`
    : neighborPreview.state === "budget_full" ? "50 个节点预算已满；请切换探索中心或移除非关键节点。"
    : "该节点在当前主题静态数据中没有任何已收录关系。";
  const canExpand = neighborPreview?.state === "available";

  if (surface === "data-workspace") return <ResearcherDataWorkspace onBack={() => setSurface("explorer")} />;
  if (error) return <main className="demo-error"><h1>KG Explorer</h1><p>{error}</p></main>;
  if (screen === "topics") return <main className="topic-shell">
    <header className="topic-topbar"><div><span className="eyebrow">MEDICAL KNOWLEDGE GRAPH</span><h1>KG Explorer</h1></div><button className="workspace-link" onClick={() => setSurface("data-workspace")}>Import Data</button></header>
    <section className="topic-hero"><span className="section-kicker">START EXPLORING</span><h2>从研究问题开始，探索实体、关系与文献。</h2><p>选择一个主题，以推荐的研究起点进入可交互知识图谱。</p></section>
    <section className="topic-grid" aria-label="研究主题">
      {manifest?.topics.map((item) => <article className="topic-card" key={item.id}><span className="topic-card-kicker">RESEARCH TOPIC</span><h3>{item.name}</h3><p>{item.description}</p><div className="topic-seeds"><span>推荐起点</span>{item.recommended_seeds.slice(0, 3).map((id) => <b key={id}>{index.find((entity) => entity.id === id)?.label ?? `#${id}`}</b>)}</div><button onClick={() => { setTopicId(item.id); setScreen("workspace"); }}>进入研究 <span>→</span></button></article>)}
    </section>
  </main>;
  return <main className="portfolio-shell">
    <header className="workspace-header"><button className="brand-button" onClick={() => setScreen("topics")}><span className="eyebrow">KG EXPLORER</span><b>研究工作区</b></button><label>主题 <select value={topicId} onChange={(event) => setTopicId(event.target.value)}>{manifest?.topics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="workspace-link" onClick={() => setSurface("data-workspace")}>Import Data</button></header>
    <section className="research-context"><div><span className="context-label">当前焦点</span><b>{entityName(entityById, focusId)}</b><small>{activeTopic?.description}</small></div><label className="global-search">搜索实体<input value={search} placeholder="搜索名称、类型或标识" onChange={(event) => setSearch(event.target.value)} /></label>{search && <div className="search-popover">{filteredSearch.length ? filteredSearch.map((entity) => <button key={entity.id} onClick={() => addSeed(entity)}><b>{entity.label}</b><small>{entity.entity_type} · {entity.categories?.map((id) => topicNames.get(id) ?? id).join(" / ")}</small></button>) : <p className="empty-note">未找到匹配实体。</p>}</div>}</section>
    <section className="trail-bar" aria-label="Research Trail"><span className="trail-label">研究路径</span><b>{entityName(entityById, seedIds[0] ?? null)}</b>{trail.map((step, index) => <button key={`${step.id}-${index}`} onClick={() => restoreStep(step, index)}>{entityName(entityById, step.focusId)}</button>)}<strong>{entityName(entityById, focusId)}</strong><button className="back-button" disabled={!trail.length} onClick={goBack}>返回上一步</button></section>
    <div className={`workspace ${selectedNode || selectedEdge ? "has-inspector" : ""}`}>
      <aside className={`explore-rail ${exploreOpen ? "open" : ""}`} aria-label="Explore controls"><button className="rail-close" onClick={() => setExploreOpen(false)} aria-label="收起探索面板">×</button><h2>探索</h2><p className="muted">从研究起点出发，逐步扩展图谱。</p>
        <label>添加研究起点<input value={search} placeholder="搜索实体" onChange={(event) => setSearch(event.target.value)} /></label>
        {search && filteredSearch.length === 0 && <p className="empty-note">未找到匹配实体。</p>}
        {filteredSearch.length > 0 && <div className="search-results">{filteredSearch.map((entity) => <button key={entity.id} onClick={() => addSeed(entity)}><b>{entity.label}</b><small>{entity.entity_type}</small></button>)}</div>}
        <div className="control-group"><span>研究起点</span>{seedIds.map((id) => <button className="pill" key={id} onClick={() => { const next = seedIds.filter((item) => item !== id); setSeedIds(next); rebuild(filters, hops, next); }}>{entityById.get(id)?.label ?? `#${id}`} ×</button>)}</div>
        <div className="control-group"><span>探索任务</span>{topic?.metadata.presets.map((preset) => <button className="preset" key={preset.id} onClick={() => { const next = { ...filters, relationCategories: new Set(preset.relation_categories) }; setSeedIds(preset.seed_ids); setHops(preset.hop); setFilters(next); if (focusId != null) { setLocalGraph(buildLocalGraph(topic, focusId, preset.seed_ids, next, preset.hop)); setMutation(createGraphRenderMutation("discovery", "initial_discovery", mutation.sequence + 1)); } }}>{preset.name}</button>)}</div>
        <label>探索范围 <select value={hops} onChange={(event) => { const next = Number(event.target.value); setHops(next); rebuild(filters, next); }}><option value={1}>直接关联</option><option value={2}>两步关联</option><option value={3}>三步关联</option></select></label>
        <button className="filters-toggle" onClick={() => setFiltersOpen((open) => !open)}>Filters {(filters.entityTypes.size + filters.relationCategories.size + filters.relations.size) ? `(${filters.entityTypes.size + filters.relationCategories.size + filters.relations.size})` : ""}<span>{filtersOpen ? "−" : "+"}</span></button>
        {filtersOpen && <div className="filter-drawer"><label>实体类型 <select multiple value={[...filters.entityTypes]} onChange={(event) => updateFilters((current) => ({ ...current, entityTypes: new Set(Array.from(event.target.selectedOptions, (option) => option.value)) }))}>{topic?.metadata.entity_type_distribution.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}</select></label><div className="control-group relation-groups"><span>关系类别</span>{topic?.metadata.relation_category_distribution.map((item) => <button className={filters.relationCategories.has(item.id) ? "facet active" : "facet"} key={item.id} onClick={() => updateFilters((current) => { const next = new Set(current.relationCategories); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return { ...current, relationCategories: next }; })}>{item.name}</button>)}</div><label>查找关系<input value={relationQuery} placeholder="输入关系名称" onChange={(event) => setRelationQuery(event.target.value)} /></label><label>具体关系 <select multiple value={[...filters.relations]} onChange={(event) => updateFilters((current) => ({ ...current, relations: new Set(Array.from(event.target.selectedOptions, (option) => option.value)) }))}>{relationOptions.map((relation) => <option key={relation} value={relation}>{relation}</option>)}</select></label>{(filters.entityTypes.size + filters.relationCategories.size + filters.relations.size) > 0 && <button className="clear-filters" onClick={() => { setFilters(cloneFilters(EMPTY_FILTERS)); rebuild(cloneFilters(EMPTY_FILTERS)); }}>清除筛选</button>}</div>}
      </aside>
      <section className="canvas-panel"><div className="canvas-toolbar" data-testid="canvas-budget"><button className="explore-trigger" onClick={() => setExploreOpen(true)}>探索与筛选</button><span className="canvas-hint">单击实体或关系查看详情</span></div>
        <div className="canvas-notices">{notice && <div className="action-note" role="status">{notice}</div>}</div>
        <div className="graph-stage" data-node-count={materialized.nodes.length} data-g6-node-count={g6Snapshot.nodeIds.length} data-g6-edge-count={g6Snapshot.edgeIds.length} data-g6-node-ids={g6Snapshot.nodeIds.join(",")} data-g6-edge-ids={g6Snapshot.edgeIds.join(",")} data-focus-id={focusId ?? ""}>{loading ? <p className="loading">正在加载研究主题…</p> : materialized.nodes.length === 0 ? <p className="loading">没有符合当前筛选的关联。请调整筛选或研究起点。</p> : <GraphCanvas viewModel={graph.viewModel} renderPatch={renderPatch} layoutPlan={layoutPlan} viewportRequest={{ sequence: mutation.sequence, mode: focusId != null && mutation.reason === "initial_discovery" ? "focus-node" : "none", nodeId: focusId == null ? null : String(focusId) }} renderNodeLabels renderEdgeLabels={false} edgeLabelSelectedDisplays={[]} showSelfLoops={false} selectedNodeId={selectedNode ? String(selectedNode.id) : null} selectedEdgeId={selectedEdge ? edgeKey(selectedEdge) : null} onNodeClick={selectNode} onEdgeClick={(_, edge) => { setSelectedEdge(edge); setSelectedNodeId(null); setExploreOpen(false); }} onGraphRendered={handleGraphRendered} onNodePositionChange={(positions) => setNodePositions((previous) => { const next = new Map(previous); let changed = false; for (const [id, position] of Object.entries(positions)) { const old = previous.get(id); if (!old || Math.abs(old.x - position.x) > .5 || Math.abs(old.y - position.y) > .5) { next.set(id, position); changed = true; } } return changed ? next : previous; })} />}</div>
        <output hidden data-testid="g6-render-snapshot">{JSON.stringify(g6Snapshot)}</output>
      </section>
      {(selectedNode || selectedEdge) && <aside className="right-panel" data-selected-node-id={selectedNode?.id ?? ""} data-selected-edge-key={selectedEdge ? edgeKey(selectedEdge) : ""}><button className="inspector-close" onClick={() => { setSelectedNodeId(null); setSelectedEdge(null); }} aria-label="关闭 Inspector">×</button>{selectedNode ? <>
        <span className="inspector-kicker">实体</span><h3>{selectedNode.label}</h3><dl><dt>类型</dt><dd>{selectedNode.entity_type}</dd></dl>
        {selectedNodeExplanation && <section className="inspector-section selection-rationale"><h4>与当前研究的关联</h4><p>{selectedNodeExplanation.selection === "seed" ? "这是当前研究起点。" : selectedNodeExplanation.selection === "manual_expand" ? "这是你在当前研究路径中主动展开的关联实体。" : selectedNodeExplanation.matchedSeedPairs.length ? "该实体连接了当前研究起点之间的路径。" : selectedNodeExplanation.supportSeeds.length > 1 ? "该实体与多个当前研究起点有关联。" : "该实体与当前研究起点存在关联。"}</p></section>}
        <div className="node-actions"><button className="primary" disabled={Boolean(pendingFocus)} onClick={centerOnSelected}>从此实体继续探索</button><button disabled={!canExpand} onClick={expandSelected}>展开关联实体</button></div>
        <section className="inspector-section"><h4>概览</h4>{selectedNode.description ? <><p className={`entity-description ${descriptionExpanded ? "expanded" : ""}`}>{selectedNode.description}</p>{selectedNode.description.length > 260 && <button className="text-button" onClick={() => setDescriptionExpanded((value) => !value)}>{descriptionExpanded ? "收起" : "查看完整描述"}</button>}</> : <p className="detail-note">暂无实体描述。</p>}<dl className="compact-details"><dt>标识</dt><dd>{selectedNode.source_identifier || "—"}</dd>{selectedNode.source && <><dt>来源</dt><dd>{selectedNode.source}</dd></>}</dl></section>
        <section className="inspector-section related-section"><div className="section-row"><h4>Connections <small>{relatedEntities.length}</small></h4><select aria-label="关联方向" value={relatedDirection} onChange={(event) => setRelatedDirection(event.target.value as "all" | "outbound" | "inbound")}><option value="all">全部方向</option><option value="outbound">仅 Source → Target</option><option value="inbound">仅 Target ← Source</option></select></div><div className="related-list">{relatedEntities.slice(0, connectionsLimit).map(({ entity, relation, direction, visible }) => <article key={relation.id} className={selectedRelatedIds.has(entity.id) ? "related-row selected" : "related-row"}><input aria-label={`选择 ${entity.label}`} type="checkbox" checked={selectedRelatedIds.has(entity.id)} onChange={() => toggleRelated(entity.id)} /><button className="related-entity" onClick={() => selectNode(entity.id)}><b>{entity.label}</b><small>{entity.entity_type} · {visible ? "画布中" : "画布外"}</small></button><button className="relation-link" data-relation-id={relation.id} onClick={() => inspectRelation(relation)} title="查看关系详情">{direction === "outbound" ? "→" : "←"} {relation.relation}</button></article>)}</div>{relatedEntities.length > connectionsLimit && <button className="text-button" onClick={() => setConnectionsLimit((limit) => limit + 12)}>显示更多关联</button>}<button className="expand-button" disabled={!selectedRelatedIds.size || Boolean(pendingFocus)} onClick={exploreSelectedRelated}>以 {selectedRelatedIds.size || 0} 个已选关联实体继续探索</button></section>
        <section className="inspector-section"><h4>支持文献 <small>{selectedNodeEvidence.length ? `${selectedNodeEvidence.length} 篇` : ""}</small></h4>{selectedNodeEvidenceGroups.length ? <><div className="evidence-groups">{(evidenceGroupsExpanded ? selectedNodeEvidenceGroups : selectedNodeEvidenceGroups.slice(0, 4)).map(({ relation, evidence }) => <div className="evidence-group" key={relation.id}><b>{relation.source === selectedNode.id ? "→" : "←"} {relation.relation}</b><small>{entityName(entityById, relation.source === selectedNode.id ? relation.target : relation.source)}</small><button className="text-button relationship-trace" onClick={() => inspectRelation(relation)}>查看此关系</button><EvidenceReferences evidence={evidence} rawEvidence={relation.evidence_raw} scope="entity" /></div>)}</div>{selectedNodeEvidenceGroups.length > 4 && <button className="text-button all-evidence-button" onClick={() => setEvidenceGroupsExpanded((value) => !value)}>{evidenceGroupsExpanded ? "收起文献" : `查看全部 ${selectedNodeEvidenceGroups.length} 组关联文献`}</button>}</> : <EvidenceReferences evidence={[]} scope="entity" />}</section>
        <div className="expand-preview"><h4>扩展当前图谱</h4><p className="expansion-status" data-expand-state={neighborPreview?.state}>{expansionStatus}</p>{neighborPreview?.typeCounts.length ? <div><span>按类型选择</span>{neighborPreview.typeCounts.map((item) => <label key={item.name}><input type="checkbox" checked={expandTypes.has(item.name)} onChange={() => setExpandTypes((items) => { const next = new Set(items); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })} />{item.name}</label>)}</div> : null}<button className="expand-button" disabled={!canExpand} onClick={expandSelected}>{canExpand ? "将关联实体加入图谱" : "暂无可展开关联"}</button></div>
      </> : selectedEdge ? <><span className="inspector-kicker">关系</span><h3>{selectedEdge.relation || "未命名关系"}</h3><dl><dt>关系方向</dt><dd>{entityName(entityById, selectedEdge.source)} → {entityName(entityById, selectedEdge.target)}</dd><dt>关系类型</dt><dd>{selectedEdge.relation || "—"}</dd>{selectedEdge.source_db && <><dt>来源</dt><dd>{selectedEdge.source_db}</dd></>}</dl><section className="endpoint-cards"><button onClick={() => selectNode(selectedEdge.source)}><small>起点实体</small><b>{entityName(entityById, selectedEdge.source)}</b></button><button onClick={() => selectNode(selectedEdge.target)}><small>终点实体</small><b>{entityName(entityById, selectedEdge.target)}</b></button></section><section className="inspector-section"><h4>支持文献 <small>{selectedEdgeEvidence.length ? `${selectedEdgeEvidence.length} 篇` : ""}</small></h4><EvidenceReferences evidence={selectedEdgeEvidence} rawEvidence={selectedEdgeData?.evidence_raw} scope="relation" /></section></> : null}
      </aside>}
    </div>
  </main>;
}
