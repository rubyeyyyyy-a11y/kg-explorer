import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from app.main import app
from app.services.spaces import registry_service


class HealthApiTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="health-api-tests-")
        self._patch_registry(self.tmpdir)
        registry_service.register_default_space()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _patch_registry(self, root: str):
        root_path = Path(root)
        registry_service.REGISTRY_ROOT = root_path
        registry_service.REGISTRY_PATH = root_path / "spaces.json"
        registry_service.LOCK_PATH = root_path / "spaces.lock"

    def _client(self):
        return TestClient(app, raise_server_exceptions=False)

    def test_live_stays_ok_when_nebula_probe_fails(self):
        with self._client() as client, mock.patch("app.services.health_service.execute_ngql", side_effect=RuntimeError("nebula down")):
            resp = client.get("/api/health/live")

        self.assertEqual(resp.status_code, 200, resp.text)
        payload = resp.json()
        self.assertEqual(payload["status"], "ok")
        self.assertNotIn("nebula", payload["checks"])

    def test_ready_does_not_fail_when_dependencies_fail(self):
        with (
            self._client() as client,
            mock.patch("app.services.health_service.execute_ngql", side_effect=RuntimeError("nebula down")),
            mock.patch("app.services.health_service.ElasticsearchClient.healthcheck", return_value=(False, 0.0, "es down")),
        ):
            resp = client.get("/api/health/ready")

        self.assertEqual(resp.status_code, 200, resp.text)
        payload = resp.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["checks"]["default_space"]["status"], "ok")
        self.assertEqual(payload["checks"]["current_space"]["status"], "ok")

    def test_dependencies_surface_nebula_es_and_space_status(self):
        with (
            self._client() as client,
            mock.patch("app.services.health_service.execute_ngql", side_effect=RuntimeError("nebula down")),
            mock.patch("app.services.health_service.ElasticsearchClient.healthcheck", return_value=(False, 0.0, "es down")),
        ):
            resp = client.get("/api/health/dependencies")

        self.assertEqual(resp.status_code, 503, resp.text)
        payload = resp.json()
        self.assertEqual(payload["status"], "down")
        self.assertEqual(payload["dependencies"]["nebula"]["status"], "down")
        self.assertEqual(payload["dependencies"]["elasticsearch"]["status"], "down")
        self.assertIn("current_space", payload["dependencies"]["space"]["metadata"])
        self.assertIn("default_space", payload["dependencies"]["space"]["metadata"])
        self.assertIn(payload["dependencies"]["index"]["status"], {"degraded", "ok", "down"})

    def test_legacy_health_is_aggregate_view(self):
        with (
            self._client() as client,
            mock.patch("app.services.health_service.execute_ngql", side_effect=RuntimeError("nebula down")),
            mock.patch("app.services.health_service.ElasticsearchClient.healthcheck", return_value=(False, 0.0, "es down")),
        ):
            resp = client.get("/api/health")

        self.assertEqual(resp.status_code, 503, resp.text)
        payload = resp.json()
        self.assertEqual(payload["checks"]["live"]["status"], "ok")
        self.assertEqual(payload["checks"]["ready"]["status"], "ok")
        self.assertEqual(payload["checks"]["dependencies"]["status"], "down")
        self.assertIn("/api/health/live", payload["compatibility"])


if __name__ == "__main__":
    unittest.main()
