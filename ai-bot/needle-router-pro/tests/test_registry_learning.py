import json
import pathlib
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from integration.router_runtime import CapabilityRegistry, ConversationPlanStore, InitialOrchestrator, LowConfidenceRoute, NeedleEmbeddedRouter, semantic_route


class RegistryLearningTest(unittest.TestCase):
    def registry(self, directory, available=True):
        path = pathlib.Path(directory) / "registry.json"
        path.write_text(json.dumps({"specialties": {"chat": ["general"], "legal": [{
            "id": "contract-review", "description": "Review agreements and contracts",
            "examples": ["review this agreement"], "availability": available,
        }]}}))
        return path

    def test_new_specialist_is_discovered_without_code_or_weight_change(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = CapabilityRegistry(self.registry(directory))
            tools = registry.needle_tools()
            self.assertIn("route__legal__contract_review", {tool["name"] for tool in tools})
            self.assertEqual(semantic_route(registry, "please review this agreement").specialty, "legal")

    def test_hot_reload_adds_specialist(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.registry(directory); registry = CapabilityRegistry(path)
            data = json.loads(path.read_text()); data["specialties"]["medical"] = ["triage"]
            time.sleep(.002); path.write_text(json.dumps(data))
            self.assertIn("medical", {candidate.specialty for candidate in registry.candidates()})

    def test_unavailable_specialist_cannot_enter_grammar(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = CapabilityRegistry(self.registry(directory, available=False))
            self.assertNotIn("route__legal__contract_review", {tool["name"] for tool in registry.needle_tools()})
            self.assertEqual(registry.validate("legal", "contract-review", {})[1], "unavailable")

    def test_learning_requires_review_and_updates_examples(self):
        with tempfile.TemporaryDirectory() as directory:
            overlay = pathlib.Path(directory) / "overlay.json"
            registry = CapabilityRegistry(self.registry(directory), overlay)
            sample = [{"text": "analise as cláusulas desse acordo", "specialty": "legal", "capability": "contract-review"}]
            with self.assertRaises(PermissionError): registry.learn_reviewed(sample, reviewed=False)
            registry.learn_reviewed(sample, reviewed=True)
            self.assertIn(sample[0]["text"], next(x for x in registry.candidates() if x.specialty == "legal").examples)

    def test_learning_rejects_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = CapabilityRegistry(self.registry(directory), pathlib.Path(directory) / "overlay.json")
            with self.assertRaises(ValueError):
                registry.learn_reviewed([{"text": "token=abc", "specialty": "legal", "capability": "contract-review"}], reviewed=True)

    def test_real_registry_understands_complete_vercel_application(self):
        registry = CapabilityRegistry(ROOT / "registry/capabilities.json")
        route = semantic_route(registry, "crie uma aplicação para o vercel, não apenas um site uma aplicação completa")
        self.assertEqual((route.specialty, route.capability), ("code", "app-development"))

    def test_complete_app_creates_multi_specialist_plan_but_code_owns_conversation(self):
        registry = CapabilityRegistry(ROOT / "registry/capabilities.json")
        route = semantic_route(registry, "crie uma aplicação completa para o vercel")
        planner = InitialOrchestrator(registry, ROOT / "config/orchestration-templates.json")
        plan = planner.plan(route, {"environment": "Vercel"})
        self.assertEqual((plan.owner_specialty, plan.owner_capability), ("code", "app-development"))
        self.assertEqual(plan.execution_mode, "multi_specialist")
        self.assertEqual(plan.required_specialties, ("design", "data", "security"))
        self.assertEqual([task.id for task in plan.tasks], [
            "architecture", "design", "data", "implementation", "security", "tests", "deployment",
        ])
        self.assertEqual([task.id for task in planner.ready_tasks(plan, set())], ["architecture"])
        self.assertEqual([task.id for task in planner.ready_tasks(plan, {"architecture"})], ["design", "data"])
        self.assertEqual([task.id for task in planner.ready_tasks(plan, {"architecture", "design", "data"})], ["implementation"])
        self.assertEqual([task.id for task in planner.ready_tasks(plan, {"architecture", "design", "data", "implementation"})], ["security", "tests"])

        store = ConversationPlanStore(planner)
        first = store.create("conversation-1", route, {"environment": "Vercel"})
        for _ in range(100):
            self.assertIs(store.create("conversation-1", route, {"environment": "ignored"}), first)
        self.assertIs(store.resume("conversation-1"), first)
        self.assertEqual(store.invocation_count["conversation-1"], 1)

    def test_embedded_model_output_not_rule_file_selects_owner(self):
        class FakeNeedle:
            def reset(self): pass
            def complete(self, prompt, max_new_tokens):
                self.prompt = prompt
                return {"function_calls": [
                    {"name": "route__code__app_development", "arguments": {}},
                    {"name": "route__code__deployment", "arguments": {}},
                ], "confidence": .91}
        backend = FakeNeedle()
        registry = CapabilityRegistry(ROOT / "registry/capabilities.json")
        router = NeedleEmbeddedRouter(registry, backend_factory=lambda tools: backend)
        decision = router.classify("crie uma aplicação completa", {"environment": "Vercel"})
        self.assertEqual((decision.owner_specialty, decision.capability), ("code", "app-development"))
        self.assertEqual(decision.execution_mode, "multi_specialist")
        self.assertIn("crie uma aplicação completa", backend.prompt)

    def test_embedded_model_low_confidence_never_activates_bot(self):
        class UncertainNeedle:
            def reset(self): pass
            def complete(self, prompt, max_new_tokens):
                return {"function_calls": [{"name": "route__code__app_development"}], "confidence": .4}
        registry = CapabilityRegistry(ROOT / "registry/capabilities.json")
        router = NeedleEmbeddedRouter(registry, backend_factory=lambda tools: UncertainNeedle())
        with self.assertRaises(LowConfidenceRoute):
            router.classify("pedido ambíguo")
