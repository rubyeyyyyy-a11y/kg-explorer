#!/usr/bin/env python3
"""Identify medically interpretable theme anchors from actual KG shards.

Read-only analysis. It intentionally uses relationship *families* for scoring
while retaining raw relationship labels in every emitted demo file.
"""
from __future__ import annotations

import csv
import heapq
import json
from array import array
from collections import Counter
from pathlib import Path

from build_static_demo_data import DEFAULT_EDGES, DEFAULT_VERTICES, input_files, norm, rows, to_id

OUT = Path(__file__).resolve().parents[1] / "theme-candidates.json"
FOCUS = {"disease", "phenotype", "drug", "gene", "tissue", "protein"}


def relation_family(value: str) -> str:
    text = value.lower()
    if "express" in text or "rna_expression" in text:
        return "expression"
    if "phenotype" in text or "feature" in text or "manifestation" in text:
        return "phenotype"
    if "target" in text or "binding" in text or "inhibit" in text or "stimulat" in text:
        return "targeting_or_effect"
    if "locat" in text or "anatom" in text:
        return "location"
    if "ingredient" in text or "component" in text or "substance" in text:
        return "composition"
    if "is_a" in text or "subclass" in text or "equivalent" in text or "chd" in text or "par" in text:
        return "ontology"
    if "associate" in text or "literature" in text:
        return "association"
    if "procedure" in text or "method" in text:
        return "procedure"
    return "other"


def main() -> None:
    vertex_paths, edge_paths = input_files(DEFAULT_VERTICES), input_files(DEFAULT_EDGES)
    type_counts: Counter[str] = Counter()
    max_id = 0
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id is None or node_id < 0:
            continue
        max_id = max(max_id, node_id)
        type_counts[norm(row.get("entity_type")) or "unclassified"] += 1
    type_names = ["unknown"] + sorted(type_counts)
    type_code = {name: idx for idx, name in enumerate(type_names)}
    type_by_id = array("H", [0]) * (max_id + 1)
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id is not None and 0 <= node_id <= max_id:
            type_by_id[node_id] = type_code[norm(row.get("entity_type")) or "unclassified"]

    degree = array("I", [0]) * (max_id + 1)
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source < 0 or target < 0 or source > max_id or target > max_id:
            continue
        if not type_by_id[source] or not type_by_id[target]:
            continue
        degree[source] += 1
        degree[target] += 1

    candidate_ids: set[int] = set()
    by_focus: dict[str, list[int]] = {}
    for focus in FOCUS:
        ids = [node_id for node_id in range(max_id + 1) if type_by_id[node_id] and type_names[type_by_id[node_id]] == focus and 20 <= degree[node_id] <= 12000]
        # Enough candidates to reveal quality without retaining a full graph in memory.
        by_focus[focus] = heapq.nlargest(1800, ids, key=lambda node_id: degree[node_id])
        candidate_ids.update(by_focus[focus])

    profiles = {node_id: {"neighbors": Counter(), "families": Counter(), "raw_relations": Counter()} for node_id in candidate_ids}
    example_neighbors: dict[int, dict[str, list[int]]] = {node_id: {} for node_id in candidate_ids}
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source > max_id or target > max_id:
            continue
        relation = norm(row.get("relation")) or "unclassified"
        family = relation_family(relation)
        for node_id, other in ((source, target), (target, source)):
            profile = profiles.get(node_id)
            if profile is None or not type_by_id[other]:
                continue
            other_type = type_names[type_by_id[other]]
            profile["neighbors"][other_type] += 1
            profile["families"][family] += 1
            profile["raw_relations"][relation] += 1
            samples = example_neighbors[node_id].setdefault(other_type, [])
            if len(samples) < 8:
                samples.append(other)

    labels: dict[int, str] = {}
    all_candidate_ids = set(candidate_ids)
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id in all_candidate_ids:
            labels[node_id] = norm(row.get("entity_name"))

    def score(node_id: int, focus: str) -> float:
        profile = profiles[node_id]
        neighbors, families = profile["neighbors"], profile["families"]
        diversity = len(neighbors)
        family_diversity = len(families)
        desired = {
            "disease": ("gene", "phenotype", "drug", "protein", "symptom"),
            "phenotype": ("disease", "gene", "symptom", "procedure", "drug"),
            "drug": ("gene", "protein", "disease", "metabolite", "procedure"),
            "gene": ("tissue", "anatomy", "disease", "phenotype", "drug", "protein"),
            "tissue": ("gene", "disease", "phenotype", "anatomy", "cell"),
            "protein": ("drug", "gene", "disease", "phenotype", "metabolite"),
        }[focus]
        cross = sum(1 for item in desired if neighbors[item] > 0)
        # Moderate, multi-type nodes beat opaque super-hubs.
        hub_penalty = max(0, degree[node_id] - 4000) / 500
        return cross * 120 + diversity * 22 + family_diversity * 18 + min(degree[node_id], 2500) / 35 - hub_penalty

    result: dict[str, list[dict[str, object]]] = {}
    for focus, ids in by_focus.items():
        ranked = sorted(ids, key=lambda node_id: score(node_id, focus), reverse=True)[:35]
        result[focus] = [{
            "id": node_id, "label": labels.get(node_id, f"Entity {node_id}"), "degree": int(degree[node_id]),
            "score": round(score(node_id, focus), 2),
            "neighbor_types": profiles[node_id]["neighbors"].most_common(),
            "relation_families": profiles[node_id]["families"].most_common(),
            "relations": profiles[node_id]["raw_relations"].most_common(12),
            "example_neighbor_ids": example_neighbors[node_id],
        } for node_id in ranked]
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(OUT)


if __name__ == "__main__":
    main()
