import unittest
from unittest import mock

from app.clients.es_client import ElasticsearchClient


class ElasticsearchSpaceAwareTest(unittest.TestCase):
    def test_document_id_uses_space_prefix(self):
        self.assertEqual(ElasticsearchClient.document_id("space_a", 42), "space_a:42")

    def test_loopback_es_url_bypasses_system_proxy(self):
        client = ElasticsearchClient(base_url="http://127.0.0.1:9200")
        fake_response = mock.MagicMock()
        fake_response.read.return_value = b'{"status":"green"}'
        fake_opener = mock.MagicMock()
        fake_opener.open.return_value.__enter__.return_value = fake_response

        with (
            mock.patch("app.clients.es_client.build_opener", return_value=fake_opener) as build_opener_mock,
            mock.patch("app.clients.es_client.urlopen") as urlopen_mock,
        ):
            payload, _took_ms = client._request_json("GET", "/_cluster/health")

        build_opener_mock.assert_called_once()
        fake_opener.open.assert_called_once()
        urlopen_mock.assert_not_called()
        self.assertEqual(payload["status"], "green")

    def test_search_query_includes_space_filter(self):
        client = ElasticsearchClient()
        captured = {}

        def fake_request(_method, _path, payload=None, **_kwargs):
            captured["payload"] = payload
            return {"hits": {"hits": []}}, 1.2

        with mock.patch.object(client, "_request_json", side_effect=fake_request):
            client.search_entity_vids(
                "alpha",
                limit=10,
                space_name="space_b",
                search_in_name=True,
                search_in_description=False,
                search_in_type=False,
                search_in_raw_id=False,
                entity_type=None,
                source=None,
            )

        filters = captured["payload"]["query"]["bool"]["filter"]
        self.assertIn({"term": {"space_name": "space_b"}}, filters)

    def test_bulk_upsert_splits_large_payloads(self):
        client = ElasticsearchClient(bulk_max_actions=1, bulk_max_bytes=1024, bulk_timeout_ms=5000)
        payload_sizes: list[int] = []

        def fake_request(_method, _path, raw_body=None, **_kwargs):
            payload_sizes.append(len(raw_body or b""))
            line_count = len([line for line in (raw_body or b"").splitlines() if line.strip()])
            item_count = line_count // 2
            return {"items": [{"index": {"status": 201}} for _ in range(item_count)]}, 1.0

        with mock.patch.object(client, "_request_json", side_effect=fake_request):
            ok, fail, _took_ms = client.bulk_upsert(
                [
                    {"vid": 1, "space_name": "space_b", "entity_name": "Alpha"},
                    {"vid": 2, "space_name": "space_b", "entity_name": "Beta"},
                ]
            )

        self.assertEqual(ok, 2)
        self.assertEqual(fail, 0)
        self.assertEqual(len(payload_sizes), 2)


if __name__ == "__main__":
    unittest.main()
