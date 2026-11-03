#!/usr/bin/env python3
"""Read-only audit of static Research Trail coverage and source-shard omission."""
from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "frontend/public/demo-data/categories"
RAW_EDGES = Path("/home/ray/workspace/kg-system/data-import/out/edges_shards")
OUT = Path("/home/ray/project-audit/kg-interactive-coverage-audit.json")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def reach(adjacency: dict[int, set[int]], node: int, depth: int) -> int:
    seen = {node}
    frontier = {node}
    for _ in range(depth):
        frontier = {other for current in frontier for other in adjacency[current] if other not in seen}
        seen.update(frontier)
    return len(seen) - 1


def main() -> None:
    manifest = load(ROOT / "frontend/public/demo-data/manifest.json")
    all_demo_ids: set[int] = set()
    topic_sets: dict[str, set[int]] = {}
    for topic in manifest["topics"]:
        ids = {item["id"] for item in load(DATA / topic["id"] / "entities.json")}
        topic_sets[topic["id"]] = ids
        all_demo_ids.update(ids)

    # Full source degrees are only collected for static-demo IDs, so the audit is
    # read-only and memory-bounded while still giving an exact omitted-neighbor count.
    raw_neighbors: dict[int, set[int]] = defaultdict(set)
    source_available = RAW_EDGES.is_dir() and any(RAW_EDGES.glob("REL2_*.csv"))
    if source_available:
        for path in sorted(RAW_EDGES.glob("REL2_*.csv")):
            with path.open(encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    try:
                        source, target = int(row.get("srcVID", "")), int(row.get("dstVID", ""))
                    except ValueError:
                        continue
                    if source in all_demo_ids:
                        raw_neighbors[source].add(target)
                    if target in all_demo_ids:
                        raw_neighbors[target].add(source)

    payload = {"source_raw_comparison_available": source_available, "topics": []}
    for topic in manifest["topics"]:
        topic_id = topic["id"]
        entities = load(DATA / topic_id / "entities.json")
        relations = load(DATA / topic_id / "relations.json")
        ids = topic_sets[topic_id]
        types = {item["id"]: item["entity_type"] for item in entities}
        adjacency: dict[int, set[int]] = defaultdict(set)
        relation_by_node: dict[int, Counter[str]] = defaultdict(Counter)
        for edge in relations:
            adjacency[edge["source"]].add(edge["target"])
            adjacency[edge["target"]].add(edge["source"])
            relation_by_node[edge["source"]][edge["relation"]] += 1
            relation_by_node[edge["target"]][edge["relation"]] += 1
        records = []
        for node in ids:
            direct = adjacency[node]
            raw = raw_neighbors.get(node, set())
            records.append({
                "id": node,
                "entity_type": types[node],
                "degree": len(direct),
                "reachable_1": reach(adjacency, node, 1),
                "reachable_2": reach(adjacency, node, 2),
                "reachable_3": reach(adjacency, node, 3),
                "neighbor_type_count": len({types[other] for other in direct}),
                "relation_type_count": len(relation_by_node[node]),
                "unshown_from_default_32": max(0, len(direct) - 31),
                "raw_neighbor_count": len(raw) if source_available else None,
                "raw_neighbors_omitted_from_topic": len(raw - ids) if source_available else None,
            })
        degree_values = sorted(item["degree"] for item in records)
        summary = {
            "id": topic_id,
            "nodes": len(ids), "relations": len(relations),
            "isolated_nodes": sum(item["degree"] == 0 for item in records),
            "terminal_nodes": sum(item["degree"] <= 1 for item in records),
            "nodes_with_unshown_neighbors_after_default_32": sum(item["unshown_from_default_32"] > 0 for item in records),
            "nodes_with_2hop": sum(item["reachable_2"] > item["reachable_1"] for item in records),
            "nodes_with_3hop": sum(item["reachable_3"] > item["reachable_2"] for item in records),
            "degree_median": degree_values[len(degree_values) // 2],
            "degree_p90": degree_values[round((len(degree_values) - 1) * .9)],
            "degree_max": degree_values[-1],
            "max_distinct_neighbor_types": max(item["neighbor_type_count"] for item in records),
            "max_distinct_relation_types": max(item["relation_type_count"] for item in records),
            "raw_omitted_neighbor_total": sum(item["raw_neighbors_omitted_from_topic"] or 0 for item in records) if source_available else None,
            "top_hubs": sorted(records, key=lambda item: (-item["degree"], item["id"]))[:10],
            "node_metrics": sorted(records, key=lambda item: item["id"]),
        }
        payload["topics"].append(summary)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(OUT), "topics": len(payload["topics"]), "source_raw_comparison_available": source_available}, ensure_ascii=False))


if __name__ == "__main__":
    main()
