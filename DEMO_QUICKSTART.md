# KG Explorer static demo

This portfolio surface is a static, read-only medical knowledge-graph explorer.
It uses only `frontend/public/demo-data/` at runtime: it does not call the
backend, NebulaGraph, Elasticsearch, or `/api/`.

## Start locally

```bash
cd /home/ray/workspace/kg-portfolio-demo/frontend
npm ci
npm run dev -- --host 127.0.0.1 --port 4175 --strictPort
```

Open `http://127.0.0.1:4175`.

For a production bundle:

```bash
cd /home/ray/workspace/kg-portfolio-demo/frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 4175 --strictPort
```

## Rebuild and validate static data

The generator reads the original import shards only; it never writes to the
source KG repository. It can take a few minutes because it scans all source
edge shards.

```bash
cd /home/ray/workspace/kg-portfolio-demo
python3 scripts/build_curated_demo_data.py
python3 scripts/verify_static_demo.py
```

The output retains real entity descriptions, original entity identifiers,
relation direction/rank/raw relation/provenance, raw source evidence text, and
only the PMID/DOI identifiers explicitly present in source evidence. PubMed
and DOI links are generated from those explicit IDs. Relationship Evidence is
aggregated for an entity only as a relationship-level view; it is not evidence
that the entity itself has been validated by every linked paper. The import
shards do not contain complete bibliographic metadata or abstracts. Optional
title/authors/journal/date come only from `pubmed-metadata.json`, which is
populated from NCBI PubMed for already explicit PMIDs.

The validator checks every emitted Relationship → Evidence association locally,
including exact agreement between `evidence_raw` and emitted PMID/DOI IDs. To
also probe live PubMed availability without crawling every citation:

```bash
python3 scripts/verify_static_demo.py --verify-pubmed-links --pubmed-probe-count 3
```

See [the Evidence Traceability case study](docs/portfolio/EVIDENCE_TRACEABILITY_CASE_STUDY.md)
for the data boundary, interaction rationale, and portfolio framing.

## Browser acceptance

```bash
cd /home/ray/workspace/kg-portfolio-demo
DEMO_URL=http://127.0.0.1:4175 \
PLAYWRIGHT_CHROME_PATH=/path/to/chrome \
node scripts/research_trail_acceptance.mjs
```

If Chromium has its shared libraries outside the system loader path, prepend
the directory that contains `libnspr4.so`, `libnss3.so`, and `libsoftokn3.so`:

```bash
LD_LIBRARY_PATH=/path/to/libs:/path/to/nss-libs \
DEMO_URL=http://127.0.0.1:4175 \
PLAYWRIGHT_CHROME_PATH=/path/to/chrome \
node scripts/research_trail_acceptance.mjs
```

`scripts/render_stability_acceptance.mjs` records first-visible and stable
render timing at 1440×900 and 1920×1080, verifies unchanged coordinates after
600 ms, and checks for console/page/API errors.
