#!/usr/bin/env python3
"""Measure the unmodified Needle engine; never substitutes estimated values."""
import argparse, json, pathlib, statistics, time
ROOT=pathlib.Path(__file__).resolve().parents[1]

def main():
 import needle
 ap=argparse.ArgumentParser(); ap.add_argument("--out",default=str(ROOT/"reports/needle-baseline.json")); args=ap.parse_args()
 registry=json.loads((ROOT/"registry/capabilities.json").read_text())
 tools=[]
 for specialty,caps in registry["specialties"].items():
  if specialty=="game" and not registry["reconciliation"]["game"]["availability"]: continue
  for cap in caps: tools.append({"name":f"{specialty}__{cap.replace('-','_')}","description":f"Route a new conversation to {specialty} for {cap.replace('-', ' ')}. Select by the user's final objective, not file format or intermediate tool.","parameters":{"type":"object","properties":{}}})
 rows=[]
 for name in ("test.jsonl","hard_test.jsonl"):
  rows += [json.loads(x) for x in (ROOT/"data/splits"/name).read_text().splitlines() if x and json.loads(x)["specialty"]!="game"]
 agent=needle.Needle(tools=tools); results=[]
 for row in rows:
  agent.reset(); system="; ".join(f"{k}: {v}" for k,v in row.get("context",{}).items()); query=row["text"]+(f"\nSystem signals: {system}" if system else "")
  started=time.perf_counter(); response=agent.complete(query,max_new_tokens=96); latency=(time.perf_counter()-started)*1000
  calls=response.get("function_calls") or []; name=calls[0]["name"] if calls else ""; pieces=name.split("__",1); predicted=pieces[0] if pieces else ""; capability=pieces[1].replace("_","-") if len(pieces)>1 else ""
  results.append({"expected":row["specialty"],"predicted":predicted,"latency_ms":latency,"confidence":response.get("confidence"),"peak_ram_mb":response.get("peak_ram_mb"),"correct":predicted==row["specialty"],"capability_correct":capability==row["capability"]})
 lat=sorted(x["latency_ms"] for x in results); pct=lambda p:lat[min(len(lat)-1,int(p*(len(lat)-1)))]
 report={"model":"Needle 2 baseline","source_tag":"v2.0.5","engine_reported_by_upstream":"2.0.2","samples":len(results),"specialty_accuracy":sum(x["correct"] for x in results)/len(results),"capability_accuracy":sum(x["capability_correct"] for x in results)/len(results),"p50_latency_ms":pct(.5),"p95_latency_ms":pct(.95),"peak_ram_mb":max(x["peak_ram_mb"] or 0 for x in results),"invalid_output_rate":sum(not x["predicted"] for x in results)/len(results),"results":results}
 pathlib.Path(args.out).parent.mkdir(parents=True,exist_ok=True); pathlib.Path(args.out).write_text(json.dumps(report,indent=2)+"\n"); print(json.dumps({k:v for k,v in report.items() if k!="results"},indent=2))
if __name__=="__main__": main()
