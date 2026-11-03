#!/usr/bin/env python3
"""Create a compact, ID-matched enrichment package from the user's local KG.

The source directory is read only.  Nothing is joined by display name: entities
use their numeric ID and relations use their two numeric endpoint IDs.  Raw
fields remain clearly labelled as source records rather than inferred facts.
"""
from __future__ import annotations

import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

csv.field_size_limit(sys.maxsize)

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "frontend/public/demo-data"
SOURCE = Path(os.environ.get("KG_LOCAL_SOURCE", "/mnt/d/资料/公司/kg"))
OUTPUT = DEMO / "local-source-enrichment.json"


def text(value: object) -> str:
    return str(value or "").strip()


def synonym_preview(value: str, label: str) -> list[str]:
    """Keep a small verbatim preview; never present this noisy legacy field as curated."""
    seen: set[str] = set()
    result: list[str] = []
    for item in value.replace("|", ";").split(";"):
        item = item.strip()
        if not item or item.casefold() == label.casefold() or len(item) > 120:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
        if len(result) == 12:
            break
    return result


def load_targets() -> tuple[set[str], set[tuple[str, str]]]:
    entity_ids = {str(item["id"]) for item in json.loads((DEMO / "index.json").read_text(encoding="utf-8"))}
    pairs: set[tuple[str, str]] = set()
    for folder in (DEMO / "categories").iterdir():
        if not folder.is_dir():
            continue
        for relation in json.loads((folder / "relations.json").read_text(encoding="utf-8")):
            pairs.add((str(relation["source"]), str(relation["target"])))
    return entity_ids, pairs


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"Local KG source is unavailable: {SOURCE}")
    entity_ids, relation_pairs = load_targets()
    entities: dict[str, dict[str, object]] = {}
    entity_file = SOURCE / "unified_entities_with_synonyms.csv"
    with entity_file.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            entity_id = text(row.get("ID"))
            if entity_id not in entity_ids:
                continue
            label = text(row.get("entity_name"))
            aliases = synonym_preview(text(row.get("synonyms")), label)
            entities[entity_id] = {
                "source_file": str(entity_file.relative_to(SOURCE)),
                "synonym_preview": aliases,
                "synonym_preview_count": len(aliases),
                "raw_synonym_present": bool(text(row.get("synonyms"))),
            }

    records: dict[str, list[dict[str, str]]] = defaultdict(list)
    scanned_files = 0
    for path in sorted((SOURCE / "edges/edges").rglob("*.csv")):
        scanned_files += 1
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                source = text(row.get("subject_our_defined_ID"))
                target = text(row.get("object_our_defined_ID"))
                if not source or not target:
                    continue
                direct = (source, target) in relation_pairs
                reverse = (target, source) in relation_pairs
                if not direct and not reverse:
                    continue
                key = f"{source}:{target}"
                record = {name: text(row.get(name)) for name in (
                    "relation", "relation_detail", "direction", "score", "source", "pmid",
                    "evidence", "evidenceType", "predicate", "relation_curie",
                ) if text(row.get(name))}
                record["source_file"] = str(path.relative_to(SOURCE))
                if record not in records[key] and len(records[key]) < 12:
                    records[key].append(record)

    payload = {
        "schema_version": 1,
        "source_root_label": "user-local KG dataset",
        "match_rule": "entity numeric ID; directed relation endpoint IDs; no display-name joins",
        "entities": entities,
        "relation_records": records,
        "stats": {
            "target_entities": len(entity_ids), "matched_entities": len(entities),
            "target_directed_relation_pairs": len(relation_pairs),
            "matched_raw_directed_pairs": len(records), "scanned_edge_files": scanned_files,
        },
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
