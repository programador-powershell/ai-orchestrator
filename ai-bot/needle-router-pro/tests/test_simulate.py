import importlib.util, json, pathlib, subprocess, sys, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("simulate",ROOT/"evaluation/simulate.py"); sim=importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)

class RouterProTest(unittest.TestCase):
 def test_minimum_thirty_simulations_and_holdouts(self):
  with tempfile.TemporaryDirectory() as d:
   out=pathlib.Path(d)/"report.json"
   subprocess.run([sys.executable,str(ROOT/"evaluation/simulate.py"),"--runs","36","--out",str(out)],check=True,capture_output=True,text=True)
   report=json.loads(out.read_text()); self.assertEqual(report["simulations_before_selection"],36); self.assertIn("hard_test",report)
 def test_fluxo_beats_code_unless_script_is_explicit(self):
  cfg=(1,1.8,2.2,2.5,.2)
  self.assertEqual(sim.classify({"text":"quando chegar mensagem envie email","context":{}},cfg)[0],"fluxo")
  self.assertEqual(sim.classify({"text":"crie um script Python que envia email","context":{}},cfg)[0],"code")
 def test_game_context_resolves_ambiguous_arena(self):
  cfg=(1,1.8,2.2,2.5,.2)
  self.assertEqual(sim.classify({"text":"faça essa arena","context":{}},cfg)[0],"chat")
  self.assertEqual(sim.classify({"text":"faça essa arena","context":{"active_game_project":True}},cfg)[0],"game")
 def test_registry_never_enables_fictitious_game_adapter(self):
  registry=json.loads((ROOT/"registry/capabilities.json").read_text()); self.assertFalse(registry["reconciliation"]["game"]["availability"])

if __name__=="__main__": unittest.main()
