#!/usr/bin/env python3
"""Reproducible pre-model search and holdout benchmark for Router Pro."""
from __future__ import annotations
import argparse, itertools, json, math, pathlib, statistics, time

ROOT = pathlib.Path(__file__).resolve().parents[1]

WORDS = {
 "code": "code código react python typescript c++ script repo tests refactor auth cron job app web aplicação aplicativo vercel full-stack".split(),
 "office": "fórmulas planilha spreadsheet slides apresentação doc document pdf células".split(),
 "design": "design imagem illustration interface responsive screen textura visual".split(),
 "data": "sql database dataset dashboard erd query analytics faturamento região normalize postgres".split(),
 "security": "security audit secrets iam permissions policy vulnerab scan".split(),
 "agent": "equipe várias duas opções pesquise implemente publique market launch".split(),
 "tuning": "fine tune tuning classifier training dataset lora".split(),
 "fluxo": "workflow fluxo automação automate trigger gatilho node webhook whatsapp crm schedule notify email".split(),
 "game": "game jogo player charactercomponent stamina ataque arena boss espada level".split(),
 "chat": "como what why explique funciona research knowledge".split(),
}
CAPS = {
 "debug": "debugging", "corrija": "debugging", "arruma": "debugging", "conserte": "debugging",
 "fórmulas": "spreadsheet", "planilha": "spreadsheet", "slides": "presentation", "apresentação": "presentation", "pdf": "pdf",
 "postgres": "database", "sql": "sql", "erd": "erd", "dashboard": "dashboard", "faturamento": "analytics",
 "webhook": "webhook", "schedule": "schedule", "todo dia": "schedule", "node": "workflow-debugging", "workflow": "workflow",
 "inventário": "inventory", "stamina": "gameplay-system", "ataque": "combat", "arena": "level", "boss": "game-project",
 "secrets": "secrets", "iam": "permissions", "audit": "audit", "fine tune": "fine-tuning", "refactor": "refactoring",
 "imagem": "image", "illustration": "image", "interface": "ui-ux", "equipe": "orchestration", "pesquise implemente": "orchestration",
 "aplicação completa": "app-development", "aplicativo completo": "app-development", "full-stack": "app-development", "web app": "app-development",
 "vercel": "deployment",
}

def load(name):
 return [json.loads(x) for x in (ROOT / "data/splits" / name).read_text().splitlines() if x]

def classify(row, cfg):
 text = row["text"].lower(); ctx = row.get("context", {}); scores = {k: 0.0 for k in WORDS}
 for spec, words in WORDS.items(): scores[spec] = sum(cfg[0] for w in words if w in text)
 if ctx.get("repository_detected"): scores["code"] += cfg[1]
 if ctx.get("active_game_project"): scores["game"] += cfg[2]
 if ctx.get("selected_artifact", "").endswith(".flow.json"): scores["fluxo"] += cfg[2]
 if "script" in text or "python" in text or "typescript" in text: scores["code"] += cfg[3]; scores["fluxo"] -= cfg[3]
 if any(q in text for q in ("como ", "what is", "why ", "explique")): scores["chat"] += cfg[3]
 if ctx.get("attachments"):
  names = " ".join(ctx["attachments"])
  if any(x in names for x in (".xlsx", ".csv")): scores["office"] += cfg[1]
 ranked = sorted(scores.items(), key=lambda x: (-x[1], x[0])); spec, top = ranked[0]; margin = top-ranked[1][1]
 ambiguous = top <= 0 or (len(text.split()) <= 3 and not any((ctx.get("active_game_project"),ctx.get("repository_detected"),ctx.get("selected_artifact"))))
 confidence = 1/(1+math.exp(-(margin-cfg[4])))
 cap = next((v for k,v in sorted(CAPS.items(),key=lambda x:-len(x[0])) if k in text), "general")
 # Criar o produto final vence a plataforma intermediária; Vercel só é
 # deployment quando o pedido principal é publicar algo que já existe.
 if any(term in text for term in ("aplicação completa", "aplicativo completo", "full-stack", "web app")): cap="app-development"
 if spec == "fluxo" and cap == "general": cap="workflow"
 if spec == "game" and cap == "general": cap="game-project"
 if spec == "code" and cap == "general": cap="coding"
 if ambiguous: spec, cap, confidence = "chat", "general", min(confidence, .45)
 return spec, cap, confidence, ambiguous

def metrics(rows,cfg):
 out=[(r,classify(r,cfg)) for r in rows]; n=len(out)
 specialty=sum(r["specialty"]==p[0] for r,p in out)/n
 capability=sum(r["capability"]==p[1] for r,p in out)/n
 clarify=sum(bool(r.get("needs_clarification"))==p[3] for r,p in out)/n
 wrong_high=sum(r["specialty"]!=p[0] and p[2]>=.78 for r,p in out)/n
 fallback=sum(p[2]<.78 for _,p in out)/n
 ece=sum(abs((1 if r["specialty"]==p[0] else 0)-p[2]) for r,p in out)/n
 score=.45*specialty+.2*capability+.15*clarify+.1*(1-ece)+.1*(1-fallback)-.5*wrong_high
 return {"specialty_accuracy":specialty,"capability_accuracy":capability,"clarification_accuracy":clarify,"ece":ece,"fallback_rate":fallback,"high_confidence_wrong_rate":wrong_high,"invalid_output_rate":0.0,"score":score}

def main():
 ap=argparse.ArgumentParser(); ap.add_argument("--runs",type=int,default=36); ap.add_argument("--out",default=str(ROOT/"reports/benchmark.json")); args=ap.parse_args()
 if args.runs < 30: raise SystemExit("at least 30 simulations are mandatory")
 grid=list(itertools.product((.8,1.0,1.2),(1.2,1.8),(1.5,2.2),(1.5,2.5),(.2,.5)))
 train=load("train.jsonl"); started=time.perf_counter(); simulations=[]
 for i,cfg in enumerate(grid[:args.runs]): simulations.append({"run":i+1,"config":cfg,"train":metrics(train,cfg)})
 winner=max(simulations,key=lambda x:(x["train"]["score"],-sum(x["config"])))
 report={"benchmark_version":"router-bench-v1","dataset_version":"router-pro-v1","simulations_before_selection":len(simulations),"selection_rule":"highest composite score; smallest weight sum breaks ties","winner_config":winner["config"],"train":winner["train"],"test":metrics(load("test.jsonl"),winner["config"]),"hard_test":metrics(load("hard_test.jsonl"),winner["config"]),"elapsed_ms":(time.perf_counter()-started)*1000,"model":{"id":"needle-router-pro-small","status":"CANDIDATE","runtime":"Needle v2.0.5 specialization profile","weights_created":False,"reason":"LoRA disables Needle calibrated confidence; production promotion requires external calibration and representative holdout"},"simulations":simulations}
 path=pathlib.Path(args.out); path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(report,indent=2)+"\n"); print(json.dumps({k:v for k,v in report.items() if k!="simulations"},indent=2))
 return 0
if __name__=="__main__": raise SystemExit(main())
