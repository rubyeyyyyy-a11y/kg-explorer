export type DemoEntity = {
  id: number;
  label: string;
  entity_type: string;
  source?: string;
  description?: string;
  source_identifier?: string;
  categories?: string[];
};

export type DemoRelation = {
  id: string;
  source: number;
  target: number;
  rank: string;
  relation: string;
  relation_category: string;
  source_db?: string;
  evidence_raw?: string;
  evidence_ids?: string[];
};

/** A source-backed citation reference.  Bibliographic fields are deliberately
 * absent unless the import shards supplied them; a PMID link is not a guessed
 * paper title or abstract. */
export type DemoEvidence = {
  id: string;
  kind: "publication" | "doi";
  pmid?: string;
  doi?: string;
  url: string;
  title?: string;
  authors?: string[];
  journal?: string;
  publication_date?: string;
  metadata_source?: string;
};

export type Distribution = { name: string; count: number };

export type TopicMetadata = {
  id: string;
  name: string;
  description: string;
  node_count: number;
  edge_count: number;
  largest_component_coverage_pct: number;
  entity_type_distribution: Distribution[];
  relation_type_distribution: Distribution[];
  relation_type_count: number;
  relation_category_distribution: Array<{ id: string; name: string; count: number }>;
  recommended_seeds: number[];
  presets: Array<{ id: string; name: string; seed_ids: number[]; hop: number; relation_categories: string[] }>;
};

export type Manifest = {
  sampled_at: string;
  node_count: number;
  relation_count: number;
  entity_type_distribution: Distribution[];
  relation_type_distribution: Distribution[];
  relation_type_count: number;
  relation_category_distribution: Array<{ id: string; name: string; count: number }>;
  topics: TopicMetadata[];
  connectivity: { largest_component_coverage_pct: number; average_degree: number; maximum_degree: number };
  evidence?: {
    records: number;
    publication_records: number;
    doi_records: number;
    relation_associations: number;
    entity_associations: number;
    relations_with_raw_evidence: number;
    bibliographic_metadata_in_source: boolean;
  };
};

export type TopicData = { entities: DemoEntity[]; relations: DemoRelation[]; evidence: DemoEvidence[]; metadata: TopicMetadata };
