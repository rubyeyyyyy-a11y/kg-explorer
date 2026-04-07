from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


HealthStatus = Literal["ok", "degraded", "down"]


class HealthComponent(BaseModel):
    status: HealthStatus
    detail: str
    reason: Optional[str] = None
    took_ms: Optional[float] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class LiveHealthResp(BaseModel):
    status: HealthStatus
    request_id: str
    timestamp: str
    checks: dict[str, HealthComponent]


class ReadyHealthResp(BaseModel):
    status: HealthStatus
    request_id: str
    timestamp: str
    checks: dict[str, HealthComponent]


class DependenciesHealthResp(BaseModel):
    status: HealthStatus
    request_id: str
    timestamp: str
    dependencies: dict[str, HealthComponent]


class LegacyHealthResp(BaseModel):
    status: HealthStatus
    request_id: str
    timestamp: str
    compatibility: str
    checks: dict[str, HealthComponent]
    dependencies: dict[str, HealthComponent]
