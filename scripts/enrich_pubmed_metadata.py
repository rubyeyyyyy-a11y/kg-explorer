#!/usr/bin/env python3
"""Fetch and cache bibliographic metadata for explicit, source-backed PMIDs.

Only PMIDs already present in the static relation evidence are requested.  The
cache is resumable and deliberately stores citation metadata, not abstracts or
new relation claims.  Source rows without a PMID remain source-record-only.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "frontend/public/demo-data"
CACHE = DEMO / "pubmed-metadata.json"
URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"


def pmids() -> set[str]:
    result: set[str] = set()
    for path in (DEMO / "categories").glob("*/evidence.json"):
        for item in json.loads(path.read_text(encoding="utf-8")):
            if item.get("kind") == "publication" and item.get("pmid"):
                result.add(str(item["pmid"]))
    return result


def request_batch(ids: list[str]) -> dict[str, dict[str, object]]:
    data = urlencode({"db": "pubmed", "id": ",".join(ids), "retmode": "json", "tool": "kg_portfolio_demo"}).encode()
    request = Request(URL, data=data, headers={"User-Agent": "kg-portfolio-demo/1.0"})
    with urlopen(request, timeout=60) as response:
        payload = json.load(response)
    result = payload.get("result", {})
    records: dict[str, dict[str, object]] = {}
    for pmid in result.get("uids", []):
        item = result.get(str(pmid), {})
        if not item or item.get("error"):
            continue
        authors = [author.get("name") for author in item.get("authors", []) if author.get("name")]
        doi = next((entry.get("value") for entry in item.get("articleids", []) if entry.get("idtype") == "doi" and entry.get("value")), None)
        records[str(pmid)] = {
            "title": item.get("title") or None,
            "authors": authors[:8],
            "journal": item.get("fulljournalname") or item.get("source") or None,
            "publication_date": item.get("pubdate") or None,
            "doi": doi,
            "pubmed_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "metadata_source": "NCBI PubMed ESummary",
        }
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=200, help="NCBI ESummary supports up to 200 IDs reliably")
    parser.add_argument("--workers", type=int, default=3, help="Keep at or below NCBI's unauthenticated 3 requests/second limit")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    all_pmids = sorted(pmids(), key=int)
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {"schema_version": 1, "records": {}, "failed_pmids": []}
    records: dict[str, dict[str, object]] = cache.setdefault("records", {})
    pending = [pmid for pmid in all_pmids if pmid not in records]
    if args.limit is not None:
        pending = pending[:args.limit]
    failed: list[str] = []
    batches = [pending[offset:offset + min(args.batch_size, 200)] for offset in range(0, len(pending), min(args.batch_size, 200))]
    completed = 0
    for offset in range(0, len(batches), max(1, args.workers)):
        group = batches[offset:offset + max(1, args.workers)]
        with ThreadPoolExecutor(max_workers=len(group)) as pool:
            futures = {pool.submit(request_batch, batch): batch for batch in group}
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    records.update(future.result())
                except Exception as error:
                    print(f"batch failed ({batch[0]}..{batch[-1]}): {error}")
                    failed.extend(batch)
                completed += len(batch)
        cache["records"] = records
        # Recompute this state instead of retaining a historical failure after a
        # later retry succeeds.  A PMID absent from records after all batches is
        # an unresolved PubMed response, not an invented bibliographic record.
        cache["failed_pmids"] = sorted(
            (pmid for pmid in all_pmids if pmid not in records), key=int
        )
        cache["source"] = "NCBI PubMed ESummary; fetched only for PMIDs explicitly present in local KG evidence"
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(json.dumps({"fetched": completed, "pending": len(pending), "cached": len(records), "failed": len(failed)}))
        time.sleep(1.05)


if __name__ == "__main__":
    main()
