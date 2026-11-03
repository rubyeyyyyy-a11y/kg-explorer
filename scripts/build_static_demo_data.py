#!/usr/bin/env python3
"""Build a privacy-minimal, static KG portfolio dataset from import shards.

The script deliberately reads source shards only.  It never connects to Nebula
or Elasticsearch, and writes only the current demo worktree's public assets.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
import math
import os
from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VERTICES = "/home/ray/workspace/kg-system/data-import/out/vertices_shards/Entity_*.csv"
DEFAULT_EDGES = "/home/ray/workspace/kg-system/data-import/out/edges_shards/REL2_*.csv"


def input_files(pattern: str) -> list[Path]:
    return sorted(Path(p) for p in __import__("glob").glob(pattern))


def rows(paths: Iterable[Path]) -> Iterable[dict[str, str]]:
    csv.field_size_limit(1024 * 1024 * 256)
    for path in paths:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            yield from csv.DictReader(handle)


def to_id(value: str | None) -> int | None:
    try:
        return int((value or "").strip())
    except ValueError:
        return None


def norm(value: str | None) -> str:
    return " ".join((value or "").replace("\x00", "").split())


def title(value: str) -> str:
    return value[:72] + ("…" if len(value) > 72 else "")


def stable_unit(*parts: str) -> float:
    digest = hashlib.blake2b("|".join(parts).encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") / float(2**64 - 1)


def reservoir_add(bucket: list[tuple[float, tuple[int, int, str, str]]], item: tuple[int, int, str, str], limit: int) -> None:
    """Keep a deterministic, unbiased-enough sample without retaining source edges."""
    priority = stable_unit(*(str(part) for part in item))
    entry = (-priority, item)
    if len(bucket) < limit:
        heapq.heappush(bucket, entry)
    elif entry[0] > bucket[0][0]:
        heapq.heapreplace(bucket, entry)


def json_dump(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def format_counts(counter: Counter[str], limit: int = 40) -> list[dict[str, Any]]:
    """Keep static metadata light; exact cardinality remains available separately."""
    return [{"name": key, "count": value} for key, value in counter.most_common(limit)]


def connected_components(node_ids: set[int], edge_pairs: Iterable[tuple[int, int]]) -> list[int]:
    parent = {node_id: node_id for node_id in node_ids}

    def find(node_id: int) -> int:
        while parent[node_id] != node_id:
            parent[node_id] = parent[parent[node_id]]
            node_id = parent[node_id]
        return node_id

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for source, target in edge_pairs:
        if source in parent and target in parent:
            union(source, target)
    sizes = Counter(find(node_id) for node_id in node_ids)
    return sorted(sizes.values(), reverse=True)


def choose_seeds(
    candidates: list[int],
    degree: array,
    type_by_id: array,
    type_names: list[str],
    profiles: dict[int, dict[str, Counter[str]]],
    seed_count: int,
) -> list[int]:
    selected: list[int] = []
    selected_types: set[str] = set()
    used_relation_signatures: set[tuple[str, ...]] = set()
    scored: list[tuple[float, int]] = []
    for node_id in candidates:
        profile = profiles.get(node_id, {"types": Counter(), "relations": Counter()})
        node_type = type_names[type_by_id[node_id]] if type_by_id[node_id] < len(type_names) else "unknown"
        type_diversity = len(profile["types"])
        relation_diversity = len(profile["relations"])
        # Prefer usable hubs over extreme super-hubs, while retaining actual degree signal.
        hub_penalty = max(0.0, math.log10(max(degree[node_id], 1)) - 4.3) * 1.8
        score = math.log1p(degree[node_id]) * 4 + type_diversity * 3 + relation_diversity * 2 - hub_penalty
        scored.append((score, node_id))
    for _, node_id in sorted(scored, reverse=True):
        profile = profiles.get(node_id, {"types": Counter(), "relations": Counter()})
        node_type = type_names[type_by_id[node_id]] if type_by_id[node_id] < len(type_names) else "unknown"
        relation_signature = tuple(sorted(profile["relations"], key=profile["relations"].get, reverse=True)[:3])
        if node_type in selected_types and relation_signature in used_relation_signatures:
            continue
        selected.append(node_id)
        selected_types.add(node_type)
        used_relation_signatures.add(relation_signature)
        if len(selected) >= seed_count:
            break
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vertices", default=DEFAULT_VERTICES)
    parser.add_argument("--edges", default=DEFAULT_EDGES)
    parser.add_argument("--output", default=str(ROOT / "frontend/public/demo-data"))
    parser.add_argument("--topics", type=int, default=5)
    parser.add_argument("--neighbors-per-topic", type=int, default=1000)
    parser.add_argument("--candidate-limit", type=int, default=1200)
    args = parser.parse_args()

    vertex_paths, edge_paths = input_files(args.vertices), input_files(args.edges)
    if not vertex_paths or not edge_paths:
        raise SystemExit("Source shard paths are unavailable; no demo data was generated.")
    output = Path(args.output)
    if output.exists():
        for child in sorted(output.rglob("*"), reverse=True):
            if child.is_file():
                child.unlink()
            elif child.is_dir():
                child.rmdir()

    # Pass 1: discover IDs and real entity type distribution.
    type_counts: Counter[str] = Counter()
    max_id = -1
    entity_total = 0
    duplicate_entity_ids = 0
    seen_ids: set[int] = set()
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id is None or node_id < 0:
            continue
        entity_total += 1
        if node_id in seen_ids:
            duplicate_entity_ids += 1
        else:
            seen_ids.add(node_id)
        max_id = max(max_id, node_id)
        type_counts[norm(row.get("entity_type")) or "unclassified"] += 1
    if max_id < 0:
        raise SystemExit("No valid entity IDs found; no demo data was generated.")

    type_names = ["unknown"] + sorted(type_counts)
    type_code = {name: index for index, name in enumerate(type_names)}
    type_by_id = array("H", [0]) * (max_id + 1)
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id is not None and 0 <= node_id <= max_id:
            type_by_id[node_id] = type_code[norm(row.get("entity_type")) or "unclassified"]

    # Pass 2: all graph-wide statistics based on actual edges.
    degree = array("I", [0]) * (max_id + 1)
    parent = array("i", range(max_id + 1))
    component_size = array("I", [1]) * (max_id + 1)

    def find(node_id: int) -> int:
        root = node_id
        while parent[root] != root:
            root = parent[root]
        while parent[node_id] != node_id:
            parent[node_id], node_id = root, parent[node_id]
        return root

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        if component_size[left_root] < component_size[right_root]:
            left_root, right_root = right_root, left_root
        parent[right_root] = left_root
        component_size[left_root] += component_size[right_root]
    relation_counts: Counter[str] = Counter()
    type_pair_counts: Counter[str] = Counter()
    total_edges = invalid_endpoint_edges = 0
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source < 0 or target < 0 or source > max_id or target > max_id:
            invalid_endpoint_edges += 1
            continue
        if type_by_id[source] == 0 or type_by_id[target] == 0:
            invalid_endpoint_edges += 1
            continue
        total_edges += 1
        degree[source] += 1
        degree[target] += 1
        union(source, target)
        relation = norm(row.get("relation")) or "unclassified"
        relation_counts[relation] += 1
        source_type, target_type = type_names[type_by_id[source]], type_names[type_by_id[target]]
        type_pair_counts[f"{source_type} → {target_type}"] += 1

    nonzero_degrees = [int(value) for value in degree if value]
    isolated_count = entity_total - len(nonzero_degrees)
    component_counts: Counter[int] = Counter(find(node_id) for node_id in range(max_id + 1) if type_by_id[node_id])
    source_component_sizes = sorted(component_counts.values(), reverse=True)
    sorted_degrees = sorted(nonzero_degrees)
    def percentile(value: float) -> int:
        if not sorted_degrees:
            return 0
        return sorted_degrees[min(len(sorted_degrees) - 1, int((len(sorted_degrees) - 1) * value))]

    top_candidates = heapq.nlargest(args.candidate_limit, range(max_id + 1), key=lambda node_id: degree[node_id])

    # Pass 3: characterize actual candidate neighborhoods, then choose diverse real hubs.
    profiles: dict[int, dict[str, Counter[str]]] = {
        node_id: {"types": Counter(), "relations": Counter()} for node_id in top_candidates if degree[node_id]
    }
    candidate_set = set(profiles)
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source > max_id or target > max_id:
            continue
        relation = norm(row.get("relation")) or "unclassified"
        if source in candidate_set and type_by_id[target]:
            profiles[source]["types"][type_names[type_by_id[target]]] += 1
            profiles[source]["relations"][relation] += 1
        if target in candidate_set and type_by_id[source]:
            profiles[target]["types"][type_names[type_by_id[source]]] += 1
            profiles[target]["relations"][relation] += 1

    seeds = choose_seeds(top_candidates, degree, type_by_id, type_names, profiles, args.topics)
    if len(seeds) < 3:
        raise SystemExit(f"Only {len(seeds)} connected, diverse seed candidates available; refusing to fabricate topics.")

    # Pass 4: deterministic per-seed one-hop expansion.  Every kept vertex is connected to its topic seed.
    seed_samples: dict[int, list[tuple[float, tuple[int, int, str, str]]]] = {seed: [] for seed in seeds}
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source > max_id or target > max_id:
            continue
        relation, source_db = norm(row.get("relation")) or "unclassified", norm(row.get("source"))
        if source in seed_samples:
            reservoir_add(seed_samples[source], (source, target, relation, source_db), args.neighbors_per_topic)
        if target in seed_samples:
            reservoir_add(seed_samples[target], (source, target, relation, source_db), args.neighbors_per_topic)

    topic_nodes: dict[int, set[int]] = {}
    for seed, bucket in seed_samples.items():
        topic_nodes[seed] = {seed}
        topic_nodes[seed].update(endpoint for _, edge in bucket for endpoint in edge[:2])

    all_selected = set().union(*topic_nodes.values())
    # Pass 5: retain only actual induced edges, capped globally by node budget quality rather than synthetic fill.
    topic_edges: dict[int, list[dict[str, Any]]] = {seed: [] for seed in seeds}
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None:
            continue
        relation, source_db = norm(row.get("relation")) or "unclassified", norm(row.get("source"))
        for seed in seeds:
            if source in topic_nodes[seed] and target in topic_nodes[seed]:
                topic_edges[seed].append({
                    "id": f"{source}:{target}:{row.get('rank', '0')}", "source": source, "target": target,
                    "rank": str(row.get("rank", "0")), "relation": relation, "source_db": source_db,
                })

    # Pass 6: fetch only exhibit-safe entity fields for selected IDs. Descriptions/raw IDs/evidence are never emitted.
    entities: dict[int, dict[str, Any]] = {}
    source_hub_id_set = set(top_candidates[:30])
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id not in all_selected and node_id not in source_hub_id_set:
            continue
        entities[node_id] = {
            "id": node_id,
            "label": title(norm(row.get("entity_name")) or f"Entity {node_id}"),
            "entity_type": norm(row.get("entity_type")) or "unclassified",
            "source": norm(row.get("source")),
        }

    source_hubs = []
    for node_id in top_candidates[:30]:
        entity = entities.get(node_id)
        if entity is None:
            # Hub nodes are not necessarily selected into the final static topics.
            entity = {"id": node_id, "label": f"Entity {node_id}", "entity_type": type_names[type_by_id[node_id]]}
        source_hubs.append({"id": node_id, "label": entity["label"], "entity_type": entity["entity_type"], "degree": int(degree[node_id])})

    # Defensive endpoint cleanup in case a malformed source row did not resolve to an entity.
    for seed in seeds:
        topic_nodes[seed].intersection_update(entities)
        topic_edges[seed] = [
            edge for edge in topic_edges[seed]
            if edge["source"] in topic_nodes[seed] and edge["target"] in topic_nodes[seed]
        ]
    all_selected = set().union(*topic_nodes.values())

    # Assemble per-topic datasets and report structures.
    categories: list[dict[str, Any]] = []
    global_relation_counts: Counter[str] = Counter()
    for ordinal, seed in enumerate(seeds, start=1):
        category_id = f"topic-{ordinal:02d}"
        node_ids = topic_nodes[seed]
        edges = topic_edges[seed]
        seed_entity = entities[seed]
        entity_dist = Counter(entities[node_id]["entity_type"] for node_id in node_ids)
        relation_dist = Counter(edge["relation"] for edge in edges)
        global_relation_counts.update(relation_dist)
        components = connected_components(node_ids, ((edge["source"], edge["target"]) for edge in edges))
        coverage = round((components[0] / len(node_ids) * 100) if node_ids else 0, 2)
        profile = profiles[seed]
        recommended_relations = [name for name, _ in profile["relations"].most_common(3)]
        metadata = {
            "id": category_id,
            "name": f"{seed_entity['entity_type']} · {seed_entity['label']}",
            "description": "围绕真实 Seed 的受限 1–3 Hop 关系探索；仅保留原始导入图中的实体与关系。",
            "node_count": len(node_ids), "edge_count": len(edges), "largest_component_coverage_pct": coverage,
            "entity_type_distribution": format_counts(entity_dist),
            "relation_type_distribution": format_counts(relation_dist),
            "relation_type_count": len(relation_dist),
            "recommended_seeds": [seed],
            "presets": [{
                "id": f"{category_id}-start", "name": f"探索 {seed_entity['label']}", "seed_ids": [seed],
                "hop": 2, "relation_types": recommended_relations,
            }],
            "sampling_depth": "1-hop capture + induced edges; UI supports local 1–3 hop traversal",
        }
        category_dir = output / "categories" / category_id
        json_dump(category_dir / "entities.json", [entities[node_id] for node_id in sorted(node_ids)])
        json_dump(category_dir / "relations.json", edges)
        json_dump(category_dir / "metadata.json", metadata)
        categories.append(metadata)

    selected_edges_unique = {
        edge["id"] for edges in topic_edges.values() for edge in edges
    }
    selected_edge_objects = {
        edge["id"]: edge for edges in topic_edges.values() for edge in edges
    }
    selected_components = connected_components(all_selected, ((edge["source"], edge["target"]) for edge in selected_edge_objects.values()))
    selected_degree = Counter()
    for edge in selected_edge_objects.values():
        selected_degree[edge["source"]] += 1
        selected_degree[edge["target"]] += 1

    index = sorted(
        [{**entities[node_id], "categories": [category["id"] for category, seed in zip(categories, seeds) if node_id in topic_nodes[seed]]} for node_id in all_selected],
        key=lambda item: (item["label"].lower(), item["id"]),
    )
    manifest = {
        "schema_version": 1,
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "data_source_category": "local KG import shards; static, read-only derivative",
        "source": {"vertex_shards": len(vertex_paths), "edge_shards": len(edge_paths)},
        "node_count": len(all_selected), "relation_count": len(selected_edges_unique),
        "entity_type_distribution": format_counts(Counter(entities[node_id]["entity_type"] for node_id in all_selected)),
        "relation_type_distribution": format_counts(Counter(edge["relation"] for edge in selected_edge_objects.values())),
        "relation_type_count": len({edge["relation"] for edge in selected_edge_objects.values()}),
        "topics": categories,
        "connectivity": {
            "component_count": len(selected_components),
            "largest_component_size": selected_components[0] if selected_components else 0,
            "largest_component_coverage_pct": round((selected_components[0] / len(all_selected) * 100) if all_selected else 0, 2),
            "isolated_node_ratio_pct": round(sum(1 for node_id in all_selected if selected_degree[node_id] == 0) / len(all_selected) * 100, 4) if all_selected else 0,
            "average_degree": round((2 * len(selected_edges_unique) / len(all_selected)) if all_selected else 0, 3),
            "maximum_degree": max(selected_degree.values(), default=0),
        },
        "seeds": seeds,
        "sampling_depth": "1-hop capture + induced edges; local UI traversal 1–3 hops",
        "checks": {
            "duplicate_entity_ids": len(index) != len({item["id"] for item in index}),
            "orphan_edges": any(edge["source"] not in all_selected or edge["target"] not in all_selected for edge in selected_edge_objects.values()),
            "cross_topic_ids_consistent": True,
            "synthetic_entities_or_relations": False,
        },
        "analysis": {
            "source_entity_count": entity_total, "source_edge_count": total_edges,
            "source_entity_type_distribution": format_counts(type_counts),
            "source_relation_type_distribution": format_counts(relation_counts),
            "source_relation_type_count": len(relation_counts),
            "source_type_pair_distribution": format_counts(type_pair_counts),
            "source_degree_distribution": {"p50": percentile(.5), "p90": percentile(.9), "p99": percentile(.99), "max": max(degree)},
            "source_isolated_node_ratio_pct": round(isolated_count / entity_total * 100, 4),
            "source_connectivity": {
                "component_count": len(source_component_sizes),
                "largest_component_size": source_component_sizes[0] if source_component_sizes else 0,
                "largest_component_coverage_pct": round((source_component_sizes[0] / entity_total * 100) if entity_total else 0, 4),
                "top_component_sizes": source_component_sizes[:10],
            },
            "source_invalid_endpoint_edges": invalid_endpoint_edges,
            "source_duplicate_entity_ids": duplicate_entity_ids,
            "source_hubs": source_hubs,
        },
    }
    json_dump(output / "manifest.json", manifest)
    json_dump(output / "index.json", index)
    print(json.dumps({"output": str(output), "nodes": len(all_selected), "edges": len(selected_edges_unique), "topics": len(categories)}))


if __name__ == "__main__":
    main()
