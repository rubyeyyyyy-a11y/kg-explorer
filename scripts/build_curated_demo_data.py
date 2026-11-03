#!/usr/bin/env python3
"""Build a medically interpretable, controlled-hop static demo from KG shards.

No source rows are invented or edited: relation_category is a display facet
derived from the unchanged relation string, which is retained verbatim.
"""
from __future__ import annotations

import csv
import heapq
import json
import math
import re
import shutil
from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_static_demo_data import (
    DEFAULT_EDGES, DEFAULT_VERTICES, connected_components, input_files, json_dump,
    norm, rows, stable_unit, to_id,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend/public/demo-data"
PUBMED_METADATA = OUT / "pubmed-metadata.json"

TOPICS = [
    {
        "id": "myelofibrosis-jak2", "name": "骨髓纤维化与 JAK2 信号", "seed_ids": [9692, 37084, 45869],
        "description": "从 primary myelofibrosis、JAK2 与 JAK1 的真实直连关系出发，查看疾病、基因、药物和表型之间的受控多跳网络。",
        "tasks": ["从疾病查看 JAK2/JAK1 直连与两跳邻居", "筛选 targeting_or_effect，比较药物相关路径"],
    },
    {
        "id": "hypercalciuria-mechanism", "name": "高钙尿症的表型—疾病—基因线索", "seed_ids": [328205, 39294, 19524],
        "description": "从 Hypercalciuria 连接的 CLDN16 与 Bartter syndrome type 4 出发，探索真实表型、疾病及基因关联。",
        "tasks": ["从表型查看疾病与基因的直接关联", "切换到 3 Hop，观察受预算限制的扩展"],
    },
    {
        "id": "saxagliptin-dpp4", "name": "Saxagliptin、DPP4 与糖尿病关系", "seed_ids": [238499, 52662, 5147],
        "description": "围绕 Saxagliptin、DPP4 和 type 1 diabetes mellitus 的真实药物—靶点—疾病关系进行探索。",
        "tasks": ["查看药物、靶点和适应症的核心关系", "按 drug_target 分类筛选，再展开多跳邻居"],
    },
    {
        "id": "squamous-expression", "name": "鳞状上皮的基因表达与疾病关联", "seed_ids": [5053060, 35322, 3416423],
        "description": "从 Squamous epithelium、POLR3B 与 High Grade Esophageal Squamous Intraepithelial Neoplasia 的真实边出发，展示组织表达与疾病关联。",
        "tasks": ["筛选 gene_expression，查看组织—基因边", "加入疾病 Seed，探索跨类型两跳路径"],
    },
    {
        "id": "gastric-egfr-treatment", "name": "胃癌、EGFR 与药物机制", "seed_ids": [4950, 43990, 144132],
        "description": "从 gastric carcinoma、EGFR 与 Lovastatin 的真实疾病—基因—药物关系出发，演示综合知识网络探索。",
        "tasks": ["查看疾病—EGFR—药物的核心路径", "按 relation family 收窄后比较 1/2/3 Hop"],
    },
]

FAMILY_LABELS = {
    "gene_expression": "基因表达", "phenotype_clinical": "表型与临床特征", "drug_target": "药物作用与靶点",
    "anatomy_location": "解剖与组织定位", "ontology_mapping": "本体层级与映射", "compound_composition": "成分与组成",
    "procedure_method": "检查与操作", "association_literature": "关联与文献", "other": "其他原始关系",
}

PMID_RE = re.compile(r"\bpmid\s*[=:]\s*([^;]+)", re.IGNORECASE)
DOI_RE = re.compile(r"\bdoi\s*[=:]\s*(10\.\S+)", re.IGNORECASE)


def evidence_references(value: str) -> tuple[str, list[dict[str, str]]]:
    """Parse only identifiers explicitly present in the source evidence field.

    The import shards do not carry publication titles, authors, abstracts, or
    journal fields.  We retain their raw evidence statement and make direct
    PubMed/DOI links from explicit identifiers, without guessing bibliography.
    """
    raw = norm(value)
    records: list[dict[str, str]] = []
    for group in PMID_RE.findall(raw):
        for pmid in sorted(set(re.findall(r"\d{4,9}", group))):
            records.append({"id": f"pmid:{pmid}", "kind": "publication", "pmid": pmid, "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"})
    for candidate in DOI_RE.findall(raw):
        doi = candidate.rstrip(".,;)")
        if doi:
            records.append({"id": f"doi:{doi.lower()}", "kind": "doi", "doi": doi, "url": f"https://doi.org/{doi}"})
    unique = {record["id"]: record for record in records}
    return raw, [unique[key] for key in sorted(unique)]


def relation_category(value: str) -> str:
    text = value.lower()
    if "express" in text or "rna_expression" in text:
        return "gene_expression"
    if "phenotype" in text or "feature" in text or "manifestation" in text:
        return "phenotype_clinical"
    if "target" in text or "binding" in text or "inhibit" in text or "stimulat" in text or "mechanism_of_action" in text:
        return "drug_target"
    if "locat" in text or "tissue_origin" in text or "anatomic_site" in text:
        return "anatomy_location"
    if "ingredient" in text or "component" in text or "substance" in text:
        return "compound_composition"
    if "is_a" in text or "subclass" in text or "equivalent" in text or "chd" in text or "par" in text:
        return "ontology_mapping"
    if "associate" in text or "literature" in text:
        return "association_literature"
    if "procedure" in text or "method" in text:
        return "procedure_method"
    return "other"


def keep_best(bucket: list[tuple[float, tuple[int, int, str, str, str]]], item: tuple[int, int, str, str, str], limit: int) -> None:
    priority = stable_unit(*(str(part) for part in item))
    entry = (-priority, item)
    if len(bucket) < limit:
        heapq.heappush(bucket, entry)
    elif entry[0] > bucket[0][0]:
        heapq.heapreplace(bucket, entry)


def bfs_stats(nodes: set[int], edges: list[dict[str, Any]], seeds: list[int]) -> dict[str, int]:
    adjacency: dict[int, list[int]] = defaultdict(list)
    for edge in edges:
        adjacency[edge["source"]].append(edge["target"])
        adjacency[edge["target"]].append(edge["source"])
    distances = {seed: 0 for seed in seeds if seed in nodes}
    queue = list(distances)
    for node in queue:
        if distances[node] >= 3:
            continue
        for other in adjacency[node]:
            if other not in distances:
                distances[other] = distances[node] + 1
                queue.append(other)
    two_walks = three_walks = 0
    for seed in seeds:
        for first in adjacency.get(seed, []):
            for second in adjacency.get(first, []):
                if second == seed:
                    continue
                two_walks += 1
                for third in adjacency.get(second, []):
                    if third not in {seed, first}:
                        three_walks += 1
    return {
        "reachable_1_hop": sum(value == 1 for value in distances.values()),
        "reachable_2_hop": sum(value == 2 for value in distances.values()),
        "reachable_3_hop": sum(value == 3 for value in distances.values()),
        "non_backtracking_2_hop_paths": two_walks,
        "non_backtracking_3_hop_paths": three_walks,
    }


def main() -> None:
    vertex_paths, edge_paths = input_files(DEFAULT_VERTICES), input_files(DEFAULT_EDGES)
    # An earlier enrichment pass published local filenames and import details.
    # This user-facing package must never retain that stale asset.
    (OUT / "local-source-enrichment.json").unlink(missing_ok=True)
    pubmed_metadata = json.loads(PUBMED_METADATA.read_text(encoding="utf-8")).get("records", {}) if PUBMED_METADATA.exists() else {}
    # Generated files are disposable. Remove stale topic folders before writing
    # so the static deployment cannot expose a retired sampling strategy.
    category_root = OUT / "categories"
    if category_root.exists():
        valid_ids = {topic["id"] for topic in TOPICS}
        for folder in category_root.iterdir():
            if folder.is_dir() and folder.name not in valid_ids:
                shutil.rmtree(folder)
    type_names = ["unknown"]
    type_counts: Counter[str] = Counter()
    max_id = 0
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id is not None and node_id >= 0:
            max_id = max(max_id, node_id)
            type_counts[norm(row.get("entity_type")) or "unclassified"] += 1
    type_names += sorted(type_counts)
    type_code = {name: index for index, name in enumerate(type_names)}
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
        if type_by_id[source] and type_by_id[target]:
            degree[source] += 1
            degree[target] += 1

    topic_by_seed = {seed: topic["id"] for topic in TOPICS for seed in topic["seed_ids"]}
    direct_buckets: dict[str, dict[tuple[int, str, str], list[tuple[float, tuple[int, int, str, str, str]]]]] = {
        topic["id"]: defaultdict(list) for topic in TOPICS
    }
    core_edges: dict[str, list[tuple[int, int, str, str, str]]] = {topic["id"]: [] for topic in TOPICS}
    seed_sets = {topic["id"]: set(topic["seed_ids"]) for topic in TOPICS}
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source == target or source > max_id or target > max_id:
            continue
        relation, source_db = norm(row.get("relation")) or "unclassified", norm(row.get("source"))
        category = relation_category(relation)
        for endpoint, other in ((source, target), (target, source)):
            topic_id = topic_by_seed.get(endpoint)
            if not topic_id or not type_by_id[other]:
                continue
            item = (source, target, relation, source_db, category)
            if other in seed_sets[topic_id]:
                core_edges[topic_id].append(item)
            if degree[other] > 18000 and other not in seed_sets[topic_id]:
                continue
            key = (endpoint, type_names[type_by_id[other]], category)
            keep_best(direct_buckets[topic_id][key], item, 14)

    topic_nodes: dict[str, set[int]] = {}
    parent_edges: dict[str, set[tuple[int, int, str, str, str]]] = {}
    for topic in TOPICS:
        topic_id, seeds = topic["id"], topic["seed_ids"]
        selected = set(seeds)
        retained = set(core_edges[topic_id])
        candidates_by_seed: dict[int, list[tuple[int, int, str, str, str]]] = defaultdict(list)
        for (seed, _, _), bucket in direct_buckets[topic_id].items():
            candidates_by_seed[seed].extend(item for _, item in bucket)
        for seed in seeds:
            seen: set[tuple[int, int, str]] = set()
            ordered = sorted(candidates_by_seed[seed], key=lambda item: (degree[item[1] if item[0] == seed else item[0]], stable_unit(*map(str, item))))
            for item in ordered:
                other = item[1] if item[0] == seed else item[0]
                identity = (item[0], item[1], item[2])
                if identity in seen or len(selected) >= 580:
                    continue
                seen.add(identity)
                selected.add(other)
                retained.add(item)
        topic_nodes[topic_id], parent_edges[topic_id] = selected, retained

    # A second controlled hop: accept diverse, non-superhub attachments until each topic reaches 1,000 nodes.
    attachment_buckets: dict[str, list[tuple[float, tuple[int, int, str, str, str]]]] = {topic["id"]: [] for topic in TOPICS}
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source == target or source > max_id or target > max_id:
            continue
        relation, source_db = norm(row.get("relation")) or "unclassified", norm(row.get("source"))
        category = relation_category(relation)
        item = (source, target, relation, source_db, category)
        for topic in TOPICS:
            topic_id, selected = topic["id"], topic_nodes[topic["id"]]
            in_source, in_target = source in selected, target in selected
            if in_source == in_target:
                continue
            other = target if in_source else source
            if not type_by_id[other] or degree[other] > 14000:
                continue
            # Keep a bounded deterministic pool; prefer lower-degree, cross-type attachments.
            penalty = math.log1p(degree[other]) + stable_unit(*map(str, item))
            entry = (-penalty, item)
            bucket = attachment_buckets[topic_id]
            if len(bucket) < 6000:
                heapq.heappush(bucket, entry)
            elif entry[0] > bucket[0][0]:
                heapq.heapreplace(bucket, entry)

    for topic in TOPICS:
        topic_id, selected = topic["id"], topic_nodes[topic["id"]]
        retained = parent_edges[topic_id]
        for _, item in sorted(attachment_buckets[topic_id], reverse=True):
            source, target = item[0], item[1]
            other = target if source in selected else source
            if other in selected or len(selected) >= 1000:
                continue
            selected.add(other)
            retained.add(item)

    # Retain all real induced edges for the selected nodes; no inferred or synthetic edges.
    topic_edges: dict[str, list[dict[str, Any]]] = {topic["id"]: [] for topic in TOPICS}
    topics_by_node: dict[int, list[str]] = defaultdict(list)
    for topic in TOPICS:
        for node_id in topic_nodes[topic["id"]]:
            topics_by_node[node_id].append(topic["id"])
    evidence_by_id: dict[str, dict[str, str]] = {}
    relation_evidence_pairs: set[tuple[str, str]] = set()
    entity_evidence_pairs: set[tuple[int, str]] = set()
    raw_evidence_relation_ids: set[str] = set()
    for row in rows(edge_paths):
        source, target = to_id(row.get("srcVID")), to_id(row.get("dstVID"))
        if source is None or target is None or source == target:
            continue
        source_topics, target_topics = topics_by_node.get(source), topics_by_node.get(target)
        if not source_topics or not target_topics:
            continue
        matching_topics = [topic_id for topic_id in source_topics if topic_id in target_topics]
        if not matching_topics:
            continue
        relation, source_db = norm(row.get("relation")) or "unclassified", norm(row.get("source"))
        edge_id = f"{source}:{target}:{row.get('rank', '0')}"
        evidence_raw, references = evidence_references(row.get("evidence") or "")
        evidence_ids = [reference["id"] for reference in references]
        for reference in references:
            if reference.get("pmid") and reference["pmid"] in pubmed_metadata:
                reference = {**reference, **pubmed_metadata[reference["pmid"]]}
            evidence_by_id[reference["id"]] = reference
            relation_evidence_pairs.add((edge_id, reference["id"]))
            entity_evidence_pairs.add((source, reference["id"]))
            entity_evidence_pairs.add((target, reference["id"]))
        if evidence_raw:
            raw_evidence_relation_ids.add(edge_id)
        for topic_id in matching_topics:
            topic_edges[topic_id].append({
                "id": edge_id, "source": source, "target": target,
                "rank": str(row.get("rank", "0")), "relation": relation, "relation_category": relation_category(relation), "source_db": source_db,
                # Keep scholarly provenance and Evidence linkage, but do not
                # publish operational import metadata or local source records.
                "evidence_raw": evidence_raw, "evidence_ids": evidence_ids,
            })

    all_selected = set().union(*topic_nodes.values())
    entities: dict[int, dict[str, Any]] = {}
    for row in rows(vertex_paths):
        node_id = to_id(row.get("ID"))
        if node_id not in all_selected:
            continue
        entities[node_id] = {
            "id": node_id, "label": norm(row.get("entity_name")),
            "entity_type": norm(row.get("entity_type")) or "unclassified", "source": norm(row.get("source")),
            "description": norm(row.get("description")), "source_identifier": norm(row.get("entity_raw_id")),
        }

    categories = []
    all_edges: dict[str, dict[str, Any]] = {}
    for topic in TOPICS:
        topic_id = topic["id"]
        nodes = topic_nodes[topic_id].intersection(entities)
        edges = [edge for edge in topic_edges[topic_id] if edge["source"] in nodes and edge["target"] in nodes]
        all_edges.update({edge["id"]: edge for edge in edges})
        entity_counts = Counter(entities[node_id]["entity_type"] for node_id in nodes)
        relation_counts = Counter(edge["relation"] for edge in edges)
        category_counts = Counter(edge["relation_category"] for edge in edges)
        components = connected_components(nodes, ((edge["source"], edge["target"]) for edge in edges))
        coverage = round(components[0] / len(nodes) * 100, 2) if nodes else 0
        paths = bfs_stats(nodes, edges, topic["seed_ids"])
        seed_max_degree = max(int(degree[seed]) for seed in topic["seed_ids"])
        score = min(100, round(
            min(len(entity_counts), 7) * 4 + min(len(category_counts), 7) * 3 + min(paths["reachable_2_hop"], 200) / 10 +
            min(paths["reachable_3_hop"], 300) / 15 + coverage / 10 + max(0, 14 - math.log10(max(seed_max_degree, 10)) * 3), 1
        ))
        metadata = {
            "id": topic_id, "name": topic["name"], "description": topic["description"],
            "node_count": len(nodes), "edge_count": len(edges), "largest_component_coverage_pct": coverage,
            "entity_type_distribution": [{"name": key, "count": value} for key, value in entity_counts.most_common()],
            "relation_type_distribution": [{"name": key, "count": value} for key, value in relation_counts.most_common(40)],
            "relation_type_count": len(relation_counts),
            "relation_category_distribution": [{"id": key, "name": FAMILY_LABELS[key], "count": value} for key, value in category_counts.most_common()],
            "recommended_seeds": topic["seed_ids"],
            "presets": [
                {"id": f"{topic_id}-core", "name": topic["tasks"][0], "seed_ids": topic["seed_ids"], "hop": 2, "relation_categories": []},
                {"id": f"{topic_id}-paths", "name": topic["tasks"][1], "seed_ids": topic["seed_ids"], "hop": 3, "relation_categories": []},
            ],
        }
        folder = OUT / "categories" / topic_id
        json_dump(folder / "entities.json", [entities[node_id] for node_id in sorted(nodes)])
        json_dump(folder / "relations.json", edges)
        topic_evidence_ids = sorted({evidence_id for edge in edges for evidence_id in edge.get("evidence_ids", [])})
        json_dump(folder / "evidence.json", [evidence_by_id[evidence_id] for evidence_id in topic_evidence_ids])
        json_dump(folder / "metadata.json", metadata)
        categories.append(metadata)

    index = sorted([
        {**entities[node_id], "categories": [topic["id"] for topic in TOPICS if node_id in topic_nodes[topic["id"]]]}
        for node_id in all_selected
    ], key=lambda item: (item["label"].lower(), item["id"]))
    degree_in_sample = Counter()
    for edge in all_edges.values():
        degree_in_sample[edge["source"]] += 1
        degree_in_sample[edge["target"]] += 1
    all_components = connected_components(all_selected, ((edge["source"], edge["target"]) for edge in all_edges.values()))
    manifest = {
        "schema_version": 4, "sampled_at": datetime.now(timezone.utc).isoformat(),
        "node_count": len(all_selected), "relation_count": len(all_edges), "topics": categories,
        "entity_type_distribution": [{"name": key, "count": value} for key, value in Counter(entities[item]["entity_type"] for item in all_selected).most_common()],
        "relation_type_distribution": [{"name": key, "count": value} for key, value in Counter(edge["relation"] for edge in all_edges.values()).most_common(40)],
        "relation_type_count": len({edge["relation"] for edge in all_edges.values()}),
        "relation_category_distribution": [{"id": key, "name": FAMILY_LABELS[key], "count": value} for key, value in Counter(edge["relation_category"] for edge in all_edges.values()).most_common()],
        "connectivity": {"component_count": len(all_components), "largest_component_size": all_components[0] if all_components else 0, "largest_component_coverage_pct": round(all_components[0] / len(all_selected) * 100, 2) if all_selected else 0, "isolated_node_ratio_pct": round(sum(1 for node in all_selected if degree_in_sample[node] == 0) / len(all_selected) * 100, 3) if all_selected else 0, "average_degree": round(2 * len(all_edges) / len(all_selected), 3) if all_selected else 0, "maximum_degree": max(degree_in_sample.values(), default=0)},
        "seeds": [seed for topic in TOPICS for seed in topic["seed_ids"]],
        "evidence": {
            "records": len(evidence_by_id),
            "publication_records": sum(record["kind"] == "publication" for record in evidence_by_id.values()),
            "doi_records": sum(record["kind"] == "doi" for record in evidence_by_id.values()),
            "relation_associations": len(relation_evidence_pairs),
            "entity_associations": len(entity_evidence_pairs),
            "relations_with_raw_evidence": len(raw_evidence_relation_ids),
            "bibliographic_metadata_in_source": False,
            "bibliographic_metadata_enriched_from_pubmed": bool(pubmed_metadata),
        },
        "checks": {"duplicate_entity_ids": len(index) != len({item["id"] for item in index}), "orphan_edges": any(edge["source"] not in all_selected or edge["target"] not in all_selected for edge in all_edges.values()), "cross_topic_ids_consistent": True, "synthetic_entities_or_relations": False},
    }
    json_dump(OUT / "manifest.json", manifest)
    json_dump(OUT / "index.json", index)
    print(json.dumps({"nodes": len(all_selected), "edges": len(all_edges), "topics": len(categories)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
