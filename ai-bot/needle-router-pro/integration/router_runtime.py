"""Hot-reloadable capability learning layer for Needle Router Pro.

The model never grants permission.  It learns newly reviewed routing examples
from an external overlay and renders the currently available entries as Needle
tools.  Consequently a new specialist does not require changing this module or
rebuilding model weights.
"""
from __future__ import annotations

import json
import importlib
import os
import pathlib
import re
import tempfile
import threading
from dataclasses import dataclass
from typing import Any

TOKEN = re.compile(r"[\w+.-]+", re.UNICODE)


def _tokens(value: str) -> set[str]:
    return {token.casefold() for token in TOKEN.findall(value)}


@dataclass(frozen=True)
class RouteCandidate:
    specialty: str
    capability: str
    description: str
    examples: tuple[str, ...]
    negative_examples: tuple[str, ...]
    availability: bool
    requirements: tuple[str, ...]
    permissions: tuple[str, ...]


@dataclass(frozen=True)
class PlannedTask:
    id: str
    specialty: str
    capability: str
    label: str
    depends_on: tuple[str, ...]
    status: str = "pending"


@dataclass(frozen=True)
class OrchestrationPlan:
    goal: str
    owner_specialty: str
    owner_capability: str
    execution_mode: str
    required_specialties: tuple[str, ...]
    tasks: tuple[PlannedTask, ...]


@dataclass(frozen=True)
class EmbeddedRouteDecision:
    owner_specialty: str
    capability: str
    confidence: float
    execution_mode: str
    requested_routes: tuple[tuple[str, str], ...]
    fallback_used: bool = False
    fallback_reason: str = ""


class LowConfidenceRoute(RuntimeError):
    pass


class CapabilityRegistry:
    """Thread-safe registry snapshot with atomic, reviewed example updates."""

    def __init__(self, registry_path: pathlib.Path, overlay_path: pathlib.Path | None = None):
        self.registry_path = pathlib.Path(registry_path)
        self.overlay_path = pathlib.Path(overlay_path) if overlay_path else None
        self._lock = threading.RLock()
        self._signature: tuple[int, int] | None = None
        self._candidates: tuple[RouteCandidate, ...] = ()
        self.reload(force=True)

    def _current_signature(self) -> tuple[int, int]:
        base = self.registry_path.stat().st_mtime_ns
        overlay = self.overlay_path.stat().st_mtime_ns if self.overlay_path and self.overlay_path.exists() else 0
        return base, overlay

    def reload(self, force: bool = False) -> bool:
        signature = self._current_signature()
        with self._lock:
            if not force and signature == self._signature:
                return False
            document = json.loads(self.registry_path.read_text())
            learned: dict[str, list[str]] = {}
            if self.overlay_path and self.overlay_path.exists():
                learned = json.loads(self.overlay_path.read_text()).get("examples", {})
            candidates = []
            for specialty, entries in document["specialties"].items():
                specialty_available = document.get("reconciliation", {}).get(specialty, {}).get("availability", True)
                for raw in entries:
                    entry = {"id": raw} if isinstance(raw, str) else raw
                    key = f"{specialty}/{entry['id']}"
                    candidates.append(RouteCandidate(
                        specialty=specialty,
                        capability=entry["id"],
                        description=entry.get("description", key),
                        examples=tuple(entry.get("examples", ())) + tuple(learned.get(key, ())),
                        negative_examples=tuple(entry.get("negative_examples", ())),
                        availability=specialty_available and entry.get("availability", True),
                        requirements=tuple(entry.get("requirements", ())),
                        permissions=tuple(entry.get("permissions", ())),
                    ))
            self._candidates, self._signature = tuple(candidates), signature
            return True

    def candidates(self) -> tuple[RouteCandidate, ...]:
        self.reload()
        with self._lock:
            return self._candidates

    def needle_tools(self) -> list[dict[str, Any]]:
        """Only available routes enter Needle's constrained output grammar."""
        return [{
            "name": f"route__{item.specialty}__{item.capability.replace('-', '_')}",
            "description": item.description + (" Examples: " + "; ".join(item.examples[:5]) if item.examples else ""),
            "parameters": {"type": "object", "properties": {}},
        } for item in self.candidates() if item.availability]

    def validate(self, specialty: str, capability: str, signals: dict[str, Any]) -> tuple[bool, str]:
        match = next((item for item in self.candidates() if item.specialty == specialty and item.capability == capability), None)
        if match is None:
            return False, "unknown_capability"
        if not match.availability:
            return False, "unavailable"
        missing = [requirement for requirement in match.requirements if not signals.get(requirement)]
        return (False, "requirements_missing:" + ",".join(missing)) if missing else (True, "valid")

    def learn_reviewed(self, samples: list[dict[str, Any]], *, reviewed: bool) -> None:
        """Persist sanitized corrections; unreviewed/raw traffic is rejected."""
        if not reviewed:
            raise PermissionError("routing examples require explicit review")
        if self.overlay_path is None:
            raise ValueError("learning overlay is not configured")
        known = {(item.specialty, item.capability) for item in self.candidates()}
        overlay = {"version": 1, "examples": {}}
        if self.overlay_path.exists():
            overlay = json.loads(self.overlay_path.read_text())
        for sample in samples:
            route = (sample["specialty"], sample["capability"])
            if route not in known:
                raise ValueError(f"unknown route: {route[0]}/{route[1]}")
            text = " ".join(str(sample["text"]).split())
            if not text or any(secret in text.casefold() for secret in ("password=", "token=", "secret=")):
                raise ValueError("empty or potentially sensitive example")
            key = "/".join(route)
            values = overlay.setdefault("examples", {}).setdefault(key, [])
            if text not in values:
                values.append(text)
        self.overlay_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.overlay_path.parent, prefix=".learning-", text=True)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(overlay, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, self.overlay_path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        self.reload(force=True)


def semantic_route(registry: CapabilityRegistry, text: str) -> RouteCandidate | None:
    """Deterministic fusion signal; never the production routing decision."""
    query = _tokens(text)
    ranked = []
    for candidate in registry.candidates():
        if not candidate.availability:
            continue
        positives = _tokens(candidate.description + " " + " ".join(candidate.examples))
        negatives = _tokens(" ".join(candidate.negative_examples))
        ranked.append((len(query & positives) - 2 * len(query & negatives), candidate))
    ranked.sort(key=lambda pair: (-pair[0], pair[1].specialty, pair[1].capability))
    return ranked[0][1] if ranked and ranked[0][0] > 0 else None


class NeedleEmbeddedRouter:
    """Runs the embedded Needle model before any bot is activated.

    Tools are generated from the live registry, so output is constrained to
    routes that exist and are available.  The first call is the conversation
    owner; additional calls are evidence that orchestration may be required.
    """

    def __init__(self, registry: CapabilityRegistry, confidence_threshold: float = .78, backend_factory=None, fallback=None):
        self.registry = registry
        self.confidence_threshold = confidence_threshold
        self.backend_factory = backend_factory or self._default_backend
        self.fallback = fallback
        self._agent = None
        self._tool_fingerprint = ""

    @staticmethod
    def _default_backend(tools):
        needle = importlib.import_module("needle")
        return needle.Needle(tools=tools, system="locale: pt-BR; device: desktop")

    def _backend(self):
        tools = self.registry.needle_tools()
        fingerprint = json.dumps(tools, sort_keys=True, ensure_ascii=False)
        if self._agent is None or fingerprint != self._tool_fingerprint:
            self._agent = self.backend_factory(tools)
            self._tool_fingerprint = fingerprint
        return self._agent

    def classify(self, user_text: str, signals: dict[str, Any] | None = None) -> EmbeddedRouteDecision:
        signals = signals or {}
        facts = "; ".join(f"{key}: {value}" for key, value in sorted(signals.items()))
        prompt = user_text + (f"\nSystem signals: {facts}" if facts else "")
        agent = self._backend()
        agent.reset()
        response = agent.complete(prompt, max_new_tokens=96)
        routes = []
        for call in response.get("function_calls") or ():
            parts = call.get("name", "").split("__", 2)
            if len(parts) != 3 or parts[0] != "route":
                continue
            specialty, capability = parts[1], parts[2].replace("_", "-")
            valid, _ = self.registry.validate(specialty, capability, signals)
            if valid and (specialty, capability) not in routes:
                routes.append((specialty, capability))
        confidence = float(response.get("confidence") or 0)
        reason = "invalid_or_empty_output" if not routes else "low_confidence"
        if not routes or confidence < self.confidence_threshold:
            if self.fallback is None:
                raise LowConfidenceRoute(f"{reason}: confidence={confidence:.4f}")
            decision = self.fallback(user_text, signals, tuple(routes), confidence, reason)
            return EmbeddedRouteDecision(**decision, fallback_used=True, fallback_reason=reason)
        owner, capability = routes[0]
        return EmbeddedRouteDecision(
            owner_specialty=owner, capability=capability, confidence=confidence,
            execution_mode="multi_specialist" if len(routes) > 1 else "single_specialist",
            requested_routes=tuple(routes),
        )


class InitialOrchestrator:
    """Plans once after initial routing; it never replaces Conversation Owner."""

    def __init__(self, registry: CapabilityRegistry, templates_path: pathlib.Path):
        self.registry = registry
        self.templates_path = pathlib.Path(templates_path)
        self.templates = json.loads(self.templates_path.read_text())["templates"]

    def plan(self, route: RouteCandidate, signals: dict[str, Any]) -> OrchestrationPlan:
        template = self.templates.get(f"{route.specialty}/{route.capability}")
        if template is None:
            return OrchestrationPlan(
                goal=route.description, owner_specialty=route.specialty,
                owner_capability=route.capability, execution_mode="single_specialist",
                required_specialties=(), tasks=(),
            )
        environment = str(signals.get("environment") or "produção")
        tasks = []
        for raw in template["tasks"]:
            valid, reason = self.registry.validate(raw["specialty"], raw["capability"], signals)
            if not valid:
                raise ValueError(f"orchestration task {raw['id']} rejected: {reason}")
            tasks.append(PlannedTask(
                id=raw["id"], specialty=raw["specialty"], capability=raw["capability"],
                label=raw["label"].format(environment=environment),
                depends_on=tuple(raw.get("depends_on", ())),
            ))
        # The owner does not appear as an auxiliary. Specialists can hibernate
        # after their task; ownership and its model policy remain unchanged.
        required = tuple(dict.fromkeys(task.specialty for task in tasks if task.specialty != route.specialty))
        return OrchestrationPlan(
            goal=template["goal_template"].format(environment=environment),
            owner_specialty=route.specialty, owner_capability=route.capability,
            execution_mode=template["execution_mode"], required_specialties=required,
            tasks=tuple(tasks),
        )

    @staticmethod
    def ready_tasks(plan: OrchestrationPlan, completed: set[str]) -> tuple[PlannedTask, ...]:
        """Scheduler view: only dependency-satisfied pending activities run."""
        return tuple(task for task in plan.tasks if task.id not in completed and set(task.depends_on) <= completed)


class ConversationPlanStore:
    """In-memory contract: automatic initial orchestration runs once per id.

    The production adapter persists the same record in Conversation storage;
    this class makes the invariant explicit and independently testable.
    """

    def __init__(self, orchestrator: InitialOrchestrator):
        self.orchestrator = orchestrator
        self._plans: dict[str, OrchestrationPlan] = {}
        self._lock = threading.RLock()
        self.invocation_count: dict[str, int] = {}

    def create(self, conversation_id: str, route: RouteCandidate, signals: dict[str, Any]) -> OrchestrationPlan:
        with self._lock:
            if conversation_id in self._plans:
                return self._plans[conversation_id]
            plan = self.orchestrator.plan(route, signals)
            self._plans[conversation_id] = plan
            self.invocation_count[conversation_id] = 1
            return plan

    def resume(self, conversation_id: str) -> OrchestrationPlan:
        with self._lock:
            if conversation_id not in self._plans:
                raise KeyError("conversation owner/plan was not persisted")
            return self._plans[conversation_id]
