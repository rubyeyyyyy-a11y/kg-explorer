#!/usr/bin/env python3
"""Validate static Demo evidence traceability without touching source KG data.

The default checks are entirely local and prove that a displayed citation can
be traced back to an emitted Relationship.  ``--verify-pubmed-links`` adds a
small, live probe of correctly constructed PubMed URLs; it never downloads or
changes source KG data.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "demo-data"
PMID_RE = re.compile(r"\bpmid\s*[=:]\s*([^;]+)", re.IGNORECASE)
DOI_RE = re.compile(r"\bdoi\s*[=:]\s*(10\.\S+)", re.IGNORECASE)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def evidence_ids_from_raw(value: str) -> set[str]:
    """Mirror the generator: only identifiers explicitly named in Evidence."""
    records: set[str] = set()
    for group in PMID_RE.findall(value or ""):
        records.update(f"pmid:{pmid}" for pmid in re.findall(r"\d{4,9}", group))
    for candidate in DOI_RE.findall(value or ""):
        doi = candidate.rstrip(".,;)")
        if doi:
            records.add(f"doi:{doi.lower()}")
    return records


def has_multi_hop_path(entities: list[dict], relations: list[dict]) -> bool:
    """Confirm a real two-hop route without publishing sampling diagnostics."""
    neighbors: dict[int, set[int]] = {item["id"]: set() for item in entities}
    for relation in relations:
        neighbors.setdefault(relation["source"], set()).add(relation["target"])
        neighbors.setdefault(relation["target"], set()).add(relation["source"])
    return any(any(neighbors.get(second, set()) - {first} for second in adjacent) for first, adjacent in neighbors.items())


def probe_pubmed_links(evidence: dict[str, dict], limit: int) -> dict:
    """Probe a deterministic, small sample; URL construction is checked for all."""
    pmids = sorted((item for item in evidence.values() if item.get("pmid")), key=lambda item: int(item["pmid"]))
    selected = pmids[:limit]
    results = []
    for item in selected:
        url = item["url"]
        try:
            request = Request(url, headers={"User-Agent": "kg-portfolio-demo-validation/1.0"})
            with urlopen(request, timeout=20) as response:
                final_url = response.geturl()
                status = getattr(response, "status", 200)
            valid_target = urlparse(final_url).netloc.endswith("pubmed.ncbi.nlm.nih.gov")
            results.append({"pmid": item["pmid"], "status": status, "final_url": final_url, "ok": status == 200 and valid_target})
        except Exception as error:  # A live network condition, never a data mutation.
            results.append({"pmid": item["pmid"], "ok": False, "error": str(error)})
    return {"checked": len(results), "results": results, "all_ok": bool(results) and all(item["ok"] for item in results)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-pubmed-links", action="store_true", help="perform a live PubMed URL probe after local linkage checks")
    parser.add_argument("--pubmed-probe-count", type=int, default=3, help="number of deterministic PubMed links to probe when enabled")
    args = parser.parse_args()
    manifest = load(ROOT / "manifest.json")
    index = load(ROOT / "index.json")
    ids = [entity["id"] for entity in index]
    unique_ids = set(ids)
    topic_results = []
    all_relation_ids = set()
    orphan_edges = 0
    all_evidence = {}
    relation_evidence_pairs = set()
    entity_evidence_pairs = set()
    entity_description_count = 0
    entity_source_identifier_count = 0
    prohibited_public_keys = {"source_updated_by", "source_updated_at", "source_version", "source_file", "local_source_records", "uploaded_by", "created_by", "updated_by"}
    prohibited_public_fields = []
    relation_raw_evidence_count = 0
    raw_evidence_relation_ids = set()
    invalid_evidence_ids = []
    evidence_raw_mismatches = []
    duplicate_evidence_conflicts = []
    node_ids_with_literature = set()
    node_ids_with_raw_evidence = set()
    for topic in manifest["topics"]:
        folder = ROOT / "categories" / topic["id"]
        entities, relations, evidence = load(folder / "entities.json"), load(folder / "relations.json"), load(folder / "evidence.json")
        entity_ids = {entity["id"] for entity in entities}
        evidence_ids = {item["id"] for item in evidence}
        for item in evidence:
            prior = all_evidence.get(item["id"])
            if prior is not None and prior != item:
                duplicate_evidence_conflicts.append({"topic": topic["id"], "evidence_id": item["id"]})
            all_evidence[item["id"]] = item
        entity_description_count += sum(bool(entity.get("description")) for entity in entities)
        entity_source_identifier_count += sum(bool(entity.get("source_identifier")) for entity in entities)
        for entity in entities:
            prohibited_public_fields.extend({"topic": topic["id"], "kind": "entity", "id": entity.get("id"), "key": key} for key in prohibited_public_keys.intersection(entity))
        missing = [edge["id"] for edge in relations if edge["source"] not in entity_ids or edge["target"] not in entity_ids]
        orphan_edges += len(missing)
        all_relation_ids.update(edge["id"] for edge in relations)
        for edge in relations:
            prohibited_public_fields.extend({"topic": topic["id"], "kind": "relation", "id": edge.get("id"), "key": key} for key in prohibited_public_keys.intersection(edge))
            if edge.get("evidence_raw"):
                relation_raw_evidence_count += 1
                raw_evidence_relation_ids.add(edge["id"])
                node_ids_with_raw_evidence.update((edge["source"], edge["target"]))
            emitted_ids = set(edge.get("evidence_ids", []))
            source_ids = evidence_ids_from_raw(edge.get("evidence_raw", ""))
            if emitted_ids != source_ids:
                evidence_raw_mismatches.append({"topic": topic["id"], "relationship_id": edge["id"], "source_ids": sorted(source_ids), "emitted_ids": sorted(emitted_ids)})
            for evidence_id in edge.get("evidence_ids", []):
                if evidence_id not in evidence_ids:
                    invalid_evidence_ids.append((topic["id"], edge["id"], evidence_id))
                    continue
                relation_evidence_pairs.add((edge["id"], evidence_id))
                entity_evidence_pairs.add((edge["source"], evidence_id))
                entity_evidence_pairs.add((edge["target"], evidence_id))
                node_ids_with_literature.update((edge["source"], edge["target"]))
        topic_results.append({
            "id": topic["id"], "nodes": len(entities), "relations": len(relations),
            "duplicate_entity_ids": len(entity_ids) != len(entities), "orphan_edges": len(missing),
            "has_seed": all(seed in entity_ids for seed in topic["recommended_seeds"]),
            "connected_target_met": topic["largest_component_coverage_pct"] >= 80,
            "has_multiple_seeds": len(topic["recommended_seeds"]) >= 2,
            "has_relation_categories": bool(topic.get("relation_category_distribution")),
            "has_real_multi_hop_paths": has_multi_hop_path(entities, relations),
            "evidence_references_resolve": not invalid_evidence_ids,
        })
    malformed_evidence = [item["id"] for item in all_evidence.values() if not ((item.get("pmid") and item.get("id") == f"pmid:{item['pmid']}" and item.get("url") == f"https://pubmed.ncbi.nlm.nih.gov/{item['pmid']}/") or (item.get("doi") and item.get("id") == f"doi:{item['doi'].lower()}" and item.get("url") == f"https://doi.org/{item['doi']}"))]
    manifest_evidence = manifest.get("evidence", {})
    pubmed_probe = probe_pubmed_links(all_evidence, max(0, args.pubmed_probe_count)) if args.verify_pubmed_links else None
    payload = {
        "manifest_nodes_match_index": manifest["node_count"] == len(index),
        "global_duplicate_entity_ids": len(ids) != len(unique_ids),
        "global_relation_count_matches": manifest["relation_count"] == len(all_relation_ids),
        "orphan_edges": orphan_edges,
        "synthetic_entities_or_relations": manifest["checks"]["synthetic_entities_or_relations"],
        "cross_topic_ids_consistent": manifest["checks"]["cross_topic_ids_consistent"],
        "evidence": {
            "unique_records": len(all_evidence),
            "relation_associations": len(relation_evidence_pairs),
            "entity_associations": len(entity_evidence_pairs),
            "relations_with_raw_evidence": len(raw_evidence_relation_ids),
            "entity_description_rows": entity_description_count,
            "entity_source_identifier_rows": entity_source_identifier_count,
            "prohibited_public_fields": prohibited_public_fields,
            "invalid_relation_references": invalid_evidence_ids,
            "raw_evidence_identifier_mismatches": evidence_raw_mismatches,
            "duplicate_publication_record_conflicts": duplicate_evidence_conflicts,
            "malformed_records": malformed_evidence,
            "node_literature_coverage": {
                "nodes_with_explicit_pmid_or_doi": len(node_ids_with_literature),
                "nodes_with_raw_evidence": len(node_ids_with_raw_evidence),
                "sampled_node_count": len(unique_ids),
                "explicit_identifier_pct": round(len(node_ids_with_literature) / len(unique_ids) * 100, 2) if unique_ids else 0,
                "raw_evidence_pct": round(len(node_ids_with_raw_evidence) / len(unique_ids) * 100, 2) if unique_ids else 0,
            },
            "manifest_matches": all((
                manifest_evidence.get("records") == len(all_evidence),
                manifest_evidence.get("relation_associations") == len(relation_evidence_pairs),
                manifest_evidence.get("entity_associations") == len(entity_evidence_pairs),
                manifest_evidence.get("relations_with_raw_evidence") == len(raw_evidence_relation_ids),
            )),
        },
        "topics": topic_results,
        "asset_bytes": sum(path.stat().st_size for path in ROOT.rglob("*.json")),
    }
    if pubmed_probe is not None:
        payload["pubmed_link_probe"] = pubmed_probe
    (ROOT / "validation.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    if not all((payload["manifest_nodes_match_index"], not payload["global_duplicate_entity_ids"], payload["global_relation_count_matches"], orphan_edges == 0, not payload["evidence"]["prohibited_public_fields"], not payload["evidence"]["invalid_relation_references"], not payload["evidence"]["raw_evidence_identifier_mismatches"], not payload["evidence"]["duplicate_publication_record_conflicts"], not payload["evidence"]["malformed_records"], payload["evidence"]["manifest_matches"], pubmed_probe is None or pubmed_probe["all_ok"], all(item["has_seed"] and item["connected_target_met"] and item["has_multiple_seeds"] and item["has_relation_categories"] and item["has_real_multi_hop_paths"] and item["evidence_references_resolve"] for item in topic_results))):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
