import type { DemoEvidence, Manifest, TopicData } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`无法加载演示数据：${response.status}`);
  return response.json() as Promise<T>;
}

export const loadManifest = () => getJson<Manifest>("/demo-data/manifest.json");
export const loadIndex = () => getJson<TopicData["entities"]>("/demo-data/index.json");

export async function loadTopic(topicId: string): Promise<TopicData> {
  const base = `/demo-data/categories/${topicId}`;
  const [entities, relations, evidence, metadata] = await Promise.all([
    getJson<TopicData["entities"]>(`${base}/entities.json`),
    getJson<TopicData["relations"]>(`${base}/relations.json`),
    getJson<DemoEvidence[]>(`${base}/evidence.json`),
    getJson<TopicData["metadata"]>(`${base}/metadata.json`),
  ]);
  return { entities, relations, evidence, metadata };
}
