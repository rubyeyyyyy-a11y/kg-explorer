# KG Explorer: Evidence Traceability

## The research problem

A medical researcher needs more than a visually plausible graph edge. After
finding a potentially relevant relation, they need to inspect the source
record, read the relationship's raw evidence, and open the cited publication
before deciding what to explore next.

KG Explorer combines that evidence check with two adjacent capabilities:

1. **Relevance-guided discovery** narrows a large, long-tailed graph to a
   research question, seed entities, filters, and controlled-hop paths.
2. **Evidence traceability** keeps citations attached to the relationship
   where they were exported, rather than presenting them as node facts.
3. **Research Trail** preserves the exploration context when a researcher
   reroots, expands, or returns to an earlier path.

This is a static, read-only portfolio demo. It uses local `/demo-data` assets
and does not claim a live backend, clinical recommendation, or causal result.

## The design decision

The data and interaction path is:

```text
Research question → relevant entity/path → Relationship ID
  → Evidence Raw + explicit PMID/DOI → original publication → next exploration
```

Putting a flat citation list on every entity would lose the source/target,
direction, raw relationship, and relationship ID that make a citation
interpretable. It could also imply that a paper validates the entity itself.
Instead, the Node Inspector aggregates adjacent relationship evidence while
retaining each Relationship as its own group. Reused PMIDs are deduplicated as
publications, but each relationship-to-publication association remains visible
and inspectable.

## What is actually exported

| Product field | Meaning and boundary |
| --- | --- |
| Entity `description` | Original entity description when present; absence remains an absence. |
| Entity source / provenance | Original entity source, IDs, version, updater, and matched local-source fields. Not a publication. |
| Relationship source | Original relationship source/provenance. Not a publication. |
| `evidence_raw` | Unmodified relationship evidence text exported from the source relation. |
| PMID / DOI | Parsed only when explicitly named in `evidence_raw`; links are deterministic PubMed/DOI URLs. |
| Bibliographic metadata | Optional title/authors/journal/date returned by NCBI PubMed only for an already explicit PMID. The import shards do not provide complete bibliographic metadata or abstracts. |

No PMID/DOI is inferred from names, sources, or relation categories. A
relationship with raw Evidence but no explicit identifier stays a raw-source
record; a relationship with neither has an honest empty state. Entity-level
literature is an aggregate of its adjacent relationships in the selected static
topic, not a claim that the entity was independently verified by those papers.

## Interaction flow

1. Start with a topic and its relevance-guided seeds, then filter or reroot the
   local graph without altering the underlying relationship fields.
2. Select an entity to read Overview, inspect real Connections, and expand
   **Supporting Literature**. Each group shows direction, the other entity,
   original relationship, relationship source, and a direct route to its
   Relationship ID.
3. Select a graph edge (or the Relationship ID) to inspect source and target,
   original direction/relation/provenance, Evidence Raw, explicit PMID/DOI,
   and any real PubMed metadata. The publication link opens in a new tab.
4. Continue from either endpoint or return through Research Trail. Evidence is
   not incorporated into the search-relevance or exploration-priority score.

Evidence presence is therefore a transparent inspection condition, not a
proxy for medical credibility. There is no unvalidated formula that boosts a
node simply because it has more PMIDs.

## Verification approach

`scripts/verify_static_demo.py` validates all emitted assets locally:

- every `evidence_ids` entry resolves in the same topic's evidence file;
- every emitted PMID/DOI exactly matches an identifier explicitly parsed from
  that relationship's `evidence_raw`;
- every PMID URL has the canonical PubMed form, and an optional small live
  probe confirms that real PubMed links open successfully;
- the output reports actual coverage for sampled nodes with raw Evidence and
  with explicit PMID/DOI, rather than assuming all entities have literature;
- IDs, endpoints, source fields, descriptions, graph topology, multi-hop
  paths, and static deployment assets remain valid.

Run the local and live-link checks with:

```bash
python3 scripts/verify_static_demo.py
python3 scripts/verify_static_demo.py --verify-pubmed-links --pubmed-probe-count 3
cd frontend && npm run build
```

The optional probe is deliberately small and deterministic: the local validator
checks the complete relationship-to-PMID mapping and every generated URL shape,
while the probe verifies that the external destination is currently reachable
without turning a static-data acceptance check into a 37,000-request crawl.

## Portfolio framing

The differentiator is not a claim that other knowledge-graph products lack
citations. It is a task-specific workflow that combines relevance-guided graph
selection, relationship-level evidence inspection, publication handoff, and
recoverable research context for medical investigation.
