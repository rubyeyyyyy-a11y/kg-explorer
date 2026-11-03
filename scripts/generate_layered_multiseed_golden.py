#!/usr/bin/env python3
"""Generate fixed golden output with the original KG implementation (read-only).

The fixture graph is intentionally synthetic and non-medical.  It exercises
algorithm semantics only; portfolio medical data is never rewritten here.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

KG_BACKEND = "/home/ray/workspace/kg-system/backend"
sys.path.insert(0, KG_BACKEND)

from app.schemas.discovery import GraphDiscoveryRequest  # noqa: E402
from app.services import graph_discovery_service as svc  # noqa: E402

ENTITIES = {
    1: {"id": 1, "label": "Seed A", "entity_type": "gene", "raw_id": "A", "source": "fixture"},
    2: {"id": 2, "label": "Seed B", "entity_type": "gene", "raw_id": "B", "source": "fixture"},
    3: {"id": 3, "label": "Bridge", "entity_type": "protein", "raw_id": "C", "source": "fixture"},
    4: {"id": 4, "label": "Shared", "entity_type": "phenotype", "raw_id": "D", "source": "fixture"},
    5: {"id": 5, "label": "disease", "entity_type": "disease", "raw_id": "E", "source": "fixture"},
    6: {"id": 6, "label": "Local A", "entity_type": "drug", "raw_id": "F", "source": "fixture"},
    7: {"id": 7, "label": "Local B", "entity_type": "anatomy", "raw_id": "G", "source": "fixture"},
    8: {"id": 8, "label": "Alt bridge", "entity_type": "protein", "raw_id": "H", "source": "fixture"},
    9: {"id": 9, "label": "Leaf", "entity_type": "symptom", "raw_id": "I", "source": "fixture"},
}
PAIRS = [(1, 3), (3, 2), (1, 4), (2, 4), (1, 5), (5, 6), (5, 7), (5, 8), (5, 9), (1, 6), (2, 7), (1, 8), (8, 2)]
EDGES = [{"source": source, "target": target, "rank": "0", "edge_type": "Relation", "relation": "related", "source_db": "fixture"} for source, target in PAIRS]


def go_edges(roots, *, rel_filter, query_scan_limit, per_root_neighbor_cap, ignore_direction=False):
    roots = set(int(item) for item in roots)
    rows = [edge for edge in EDGES if edge["source"] in roots or (ignore_direction and edge["target"] in roots)]
    if not ignore_direction:
        # Original adapter returns both directions around a root for discovery.
        rows = [edge for edge in EDGES if edge["source"] in roots or edge["target"] in roots]
    if rel_filter:
        rows = [edge for edge in rows if edge["relation"].lower() in rel_filter or edge["relation"] in rel_filter]
    return rows[:query_scan_limit], {"scanned_rows": len(rows), "dropped_by_relation": 0, "dropped_by_neighbor_cap": 0}


def run(name, **kwargs):
    req = GraphDiscoveryRequest(ranking_mode="layered_multiseed", include_candidate_candidate_edges=True, top_k_per_type=20, **kwargs)
    response = svc._discovery_layered(req)
    return {
        "name": name,
        "input": kwargs,
        "nodes": [{key: node.get(key) for key in ("id", "layer", "priority_score", "min_seed_distance", "bridge_seed_count", "local_anchor_seed", "matched_seed_pairs", "seed_support_vids", "score_breakdown")} for node in response["nodes"]],
        "edges": [{key: edge.get(key) for key in ("source", "target", "rank", "layer", "priority_score", "seed_support_vids", "path_pair", "is_backbone")} for edge in response["edges"]],
        "dropped": [{"node_id": item["node_id"], "reason": getattr(item["reason"], "value", str(item["reason"]))} for item in response["dropped_candidates"]],
    }


svc._fetch_entity_nodes = lambda ids: {int(item): ENTITIES[int(item)] for item in ids if int(item) in ENTITIES}
svc._go_edges_from = go_edges
svc._find_shortest_path_candidates_bfs = lambda src, dst, max_hop, rel_filter, query_scan_limit, per_root_neighbor_cap, ignore_direction, candidate_limit: (__import__("app.platform.graph.traversal_service", fromlist=["_find_shortest_path_candidates_bfs"])._find_shortest_path_candidates_bfs(src, dst, max_hop, rel_filter, query_scan_limit, per_root_neighbor_cap, ignore_direction, candidate_limit, go_edges_from_fn=go_edges))

CASES = [
    run("single_seed_local", seed_vids=[1], hop=2, max_nodes=8, max_edges=20),
    run("two_seed_shared", seed_vids=[1, 2], hop=1, max_nodes=8, max_edges=20),
    run("two_seed_bridge", seed_vids=[1, 2], hop=2, max_nodes=8, max_edges=20),
    run("generic_hub", seed_vids=[1], hop=1, max_nodes=3, max_edges=20),
    run("layers", seed_vids=[1, 2], hop=2, max_nodes=8, max_edges=20),
    run("distance", seed_vids=[1, 2], hop=3, max_nodes=8, max_edges=20),
    run("type_budget", seed_vids=[1, 2], hop=2, max_nodes=7, max_edges=20),
    run("node_budget", seed_vids=[1, 2], hop=2, max_nodes=3, max_edges=20),
    run("edge_budget", seed_vids=[1, 2], hop=2, max_nodes=8, max_edges=2),
    run("no_path_after_filter", seed_vids=[1, 2], allowed_relation_types=["absent"], hop=2, max_nodes=8, max_edges=20),
    run("equal_shortest_path", seed_vids=[1, 2], hop=2, max_nodes=4, max_edges=20),
    run("stable_tie", seed_vids=[1], hop=1, max_nodes=5, max_edges=20),
]

fixture_dir = Path(__file__).parent / "fixtures"
fixture_dir.mkdir(exist_ok=True)
(fixture_dir / "layered_multiseed_python_golden.json").write_text(json.dumps({"entities": list(ENTITIES.values()), "relations": [{**edge, "id": f"{edge['source']}:{edge['target']}:0", "relation_category": "fixture"} for edge in EDGES], "cases": CASES}, indent=2) + "\n")
