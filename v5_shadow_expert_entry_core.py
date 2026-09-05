#!/usr/bin/env python3
"""
V5 SHADOW EXPERT ENTRY CORE
RESEARCH / HISTORICAL VALIDATION ONLY
NO SCANNER / NO PAPER / NO LIVE / NO ORDERS

Purpose: prove entry edge before adding structure exits, runner logic, or adaptive sizing.

Point-in-time architecture:
- Every replay signal is shadow-evaluated with exact fixed 1.8R / 24h stop-first logic.
- Only completed historical shadow outcomes can affect current decisions.
- Dynamic quality thresholds are rolling quantiles, not fixed score cutoffs.
- Four pre-registered experts vote from structure quality + stop-width percentiles.
- Each expert must be healthy on its own last completed qualified shadows.
- Trade requires consensus from at least 3 healthy experts.
- Flat 0.15% equity risk isolates entry quality; 5x is margin-only.
"""
from __future__ import annotations
import argparse, csv, gzip, hashlib, json, math
from pathlib import Path
from typing import Any, Dict, List, Tuple

VERSION = "V5_SHADOW_EXPERT_ENTRY_CORE_1"
STARTING_EQUITY = 100.0
BAR_MS = 5 * 60 * 1000
HORIZON_MS = 24 * 60 * 60 * 1000

POLICY = {
    "entryProof": {
        "fixedTargetR": 1.8,
        "horizonHours": 24,
        "sameBarPriority": "STOP_FIRST",
        "rollingAllCompleted": 180,
        "minAllCompleted": 60,
        "experts": [
            {"name": "BROAD", "structureQuantile": 0.60, "stopRiskQuantile": 0.50},
            {"name": "QUALITY", "structureQuantile": 0.70, "stopRiskQuantile": 0.60},
            {"name": "TOP", "structureQuantile": 0.80, "stopRiskQuantile": 0.60},
            {"name": "WIDE_TOP", "structureQuantile": 0.75, "stopRiskQuantile": 0.70},
        ],
        "expertHealth": {
            "windowQualifiedCompleted": 45,
            "minQualifiedCompleted": 15,
            "minStressExpectancyRExclusive": 0.0,
            "minStressProfitFactor": 1.05,
        },
        "minHealthyExpertVotes": 3,
        "noSymbolDirectionStatusManualExclusions": True,
    },
    "risk": {
        "riskPctEquity": 0.15,
        "leverageMarginOnly": 5,
        "maxConcurrent": 2,
        "onePerSymbol": True,
        "maxOpenRiskPctEquity": 0.30,
        "maxMarginUtilizationPct": 50.0,
    },
    "costs": {
        "BASE": {"feeBpsPerFill": 5.0, "slippageBpsPerFill": 1.0, "fundingDebitBpsPer8h": 0.5},
        "STRESS": {"feeBpsPerFill": 5.0, "slippageBpsPerFill": 3.0, "fundingDebitBpsPer8h": 1.0},
    },
}

CONSUMED_GATE = {
    "allBlocksEndingEquityAtLeast": 100.0,
    "allTradedBlocksStressExpectancyRAtLeast": 0.0,
    "allTradedBlocksStressProfitFactorAtLeast": 1.0,
    "productiveBlocksAtLeast": 4,
    "productiveBlockMinTrades": 10,
    "maxStressDrawdownPct": 2.0,
}

FRESH_GATE = {
    "baseEndingEquityAtLeast": 100.0,
    "stressEndingEquityAtLeast": 100.0,
    "stressProfitFactorUsdAtLeast": 1.05,
    "stressEntryExpectancyRAbove": 0.0,
    "minTradesTaken": 10,
    "baseMaxDrawdownPctAtMost": 3.0,
    "stressMaxDrawdownPctAtMost": 3.5,
    "maxOpenRiskPctAtMost": 0.30,
    "maxMarginUtilizationPctAtMost": 50.0,
}

def policy_fingerprint() -> str:
    raw = json.dumps({"version": VERSION, "policy": POLICY}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def load_signals(path: Path) -> List[Dict[str, Any]]:
    x = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(x, list):
        raise RuntimeError(f"Signals file is not an array: {path}")
    return x

def symbol_to_file(symbol: str) -> str:
    return symbol.replace("-", "_") + "_5m.csv.gz"

def load_bars(path: Path) -> List[Tuple[int, float, float, float]]:
    rows = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            rows.append((int(r["openTimeMs"]), float(r["high"]), float(r["low"]), float(r["close"])))
    return rows

def first_after(bars, ts: int) -> int:
    lo, hi = 0, len(bars)
    while lo < hi:
        mid = (lo + hi) // 2
        if bars[mid][0] <= ts:
            lo = mid + 1
        else:
            hi = mid
    return lo

def exact_fixed_event(signal: Dict[str, Any], bars: List[Tuple[int, float, float, float]]) -> Dict[str, Any]:
    ts = int(signal["timestampMs"])
    entry = float(signal["entry"]); stop = float(signal["stop"])
    direction = str(signal["direction"]).upper()
    risk = abs(entry - stop)
    if not (entry > 0 and risk > 0):
        raise RuntimeError("Invalid entry/stop geometry")
    target = entry + 1.8 * risk if direction == "LONG" else entry - 1.8 * risk
    idx = first_after(bars, ts); end_ts = ts + HORIZON_MS
    gross = exit_price = exit_reason = None; bars_held = 0; last_close = None
    while idx < len(bars):
        bt, high, low, close = bars[idx]
        if bt > end_ts: break
        bars_held += 1; last_close = close
        if direction == "LONG":
            if low <= stop: gross, exit_price, exit_reason = -1.0, stop, "INITIAL_STOP"; break
            if high >= target: gross, exit_price, exit_reason = 1.8, target, "TP1"; break
        elif direction == "SHORT":
            if high >= stop: gross, exit_price, exit_reason = -1.0, stop, "INITIAL_STOP"; break
            if low <= target: gross, exit_price, exit_reason = 1.8, target, "TP1"; break
        else:
            raise RuntimeError(f"Unexpected direction {direction}")
        idx += 1
    if gross is None:
        if bars_held <= 0 or last_close is None: raise RuntimeError("No future bars available")
        exit_price = last_close
        raw_r = (exit_price-entry)/risk if direction == "LONG" else (entry-exit_price)/risk
        gross = max(-1.0, min(1.8, raw_r)); exit_reason = "HORIZON"
    rf = risk / entry; hours = bars_held * 5.0 / 60.0; scenarios = {}
    for name,cfg in POLICY["costs"].items():
        fill_rate = (cfg["feeBpsPerFill"] + cfg["slippageBpsPerFill"]) / 10000.0
        trading = fill_rate * (entry + float(exit_price)) / risk
        funding = (cfg["fundingDebitBpsPer8h"] / 10000.0) * (entry/risk) * (hours/8.0)
        scenarios[name] = {"netResultR": gross-trading-funding, "tradingCostR":trading, "fundingStressR":funding, "totalCostR":trading+funding}
    return {
        "timestamp": signal.get("timestamp"), "timestampMs": ts, "closeTs": ts + bars_held*BAR_MS,
        "symbol": signal["symbol"], "direction": direction,
        "finalScore": float(signal.get("finalScore",0)), "radarScore": float(signal.get("radarScore",0)),
        "directionScore": float(signal.get("directionScore",0)), "structureScore": float(signal.get("structureScore",0)),
        "flowScore": float(signal.get("flowScore",0)), "structureStatus": signal.get("structureStatus"),
        "entry": entry, "stop": stop, "riskFraction": rf, "barsHeld": bars_held,
        "exitReason": exit_reason, "grossResultR": gross, "costScenarios": scenarios,
    }

def build_events(signals_path: Path, data_dir: Path) -> List[Dict[str, Any]]:
    signals = load_signals(signals_path); cache = {}; out = []
    for s in signals:
        sym = s["symbol"]
        if sym not in cache:
            fp = data_dir / symbol_to_file(sym)
            if not fp.exists(): raise RuntimeError(f"Missing frozen bars {fp}")
            cache[sym] = load_bars(fp)
        out.append(exact_fixed_event(s, cache[sym]))
    out.sort(key=lambda e:(e["timestampMs"], -e["structureScore"], -e["riskFraction"], e["symbol"]))
    return out

def pf(values: List[float]) -> float:
    win = sum(v for v in values if v > 0); loss = -sum(v for v in values if v < 0)
    if loss <= 0: return 99.0 if win > 0 else 0.0
    return win/loss

def quantile(values: List[float], q: float) -> float:
    if not values: return math.nan
    x = sorted(float(v) for v in values); pos = (len(x)-1)*q; lo = int(math.floor(pos)); hi = int(math.ceil(pos))
    if lo == hi: return x[lo]
    w = pos-lo; return x[lo]*(1.0-w)+x[hi]*w

def max_drawdown_pct(points: List[float]) -> float:
    peak = points[0] if points else STARTING_EQUITY; dd = 0.0
    for x in points:
        peak=max(peak,x)
        if peak>0: dd=max(dd,(peak-x)/peak*100.0)
    return dd

def prepare_expert_flags(events: List[Dict[str,Any]]) -> List[Dict[str,bool]]:
    groups={}
    for i,e in enumerate(events): groups.setdefault(e["timestampMs"],[]).append((i,e))
    pending=[]; completed=[]; flags=[{} for _ in events]
    roll=POLICY["entryProof"]["rollingAllCompleted"]; min_all=POLICY["entryProof"]["minAllCompleted"]
    experts=POLICY["entryProof"]["experts"]
    for ts in sorted(groups):
        ready=[x for x in pending if x[0] <= ts]; pending=[x for x in pending if x[0] > ts]
        for _,e in sorted(ready,key=lambda z:z[0]): completed.append(e)
        hist=completed[-roll:]
        thresholds={}
        if len(hist)>=min_all:
            svals=[e["structureScore"] for e in hist]; rvals=[e["riskFraction"] for e in hist]
            for ex in experts:
                thresholds[ex["name"]]=(quantile(svals,ex["structureQuantile"]), quantile(rvals,ex["stopRiskQuantile"]))
        for i,e in groups[ts]:
            for ex in experts:
                name=ex["name"]
                if name not in thresholds: flags[i][name]=False
                else:
                    st,rt=thresholds[name]; flags[i][name]=(e["structureScore"]>=st and e["riskFraction"]>=rt)
            pending.append((e["closeTs"],e))
    return flags

def simulate(events: List[Dict[str,Any]], scenario: str) -> Dict[str,Any]:
    flags=prepare_expert_flags(events); experts=[x["name"] for x in POLICY["entryProof"]["experts"]]
    hp=POLICY["entryProof"]["expertHealth"]; hwin=hp["windowQualifiedCompleted"]; hmin=hp["minQualifiedCompleted"]
    groups={}
    for i,e in enumerate(events): groups.setdefault(e["timestampMs"],[]).append((i,e))
    pending=[]; hists={name:[] for name in experts}; active=[]; equity=STARTING_EQUITY; eq=[equity]; trades=[]
    max_open=0.0; max_margin=0.0; vote_counts={}; expert_qual_counts={name:0 for name in experts}; expert_green_counts={name:0 for name in experts}
    selected_r=[]
    def flush(ts):
        nonlocal equity,active
        due=[p for p in active if p["closeTs"]<=ts]; active=[p for p in active if p["closeTs"]>ts]
        for p in sorted(due,key=lambda x:(x["closeTs"],x["symbol"])):
            equity += p["pnlUsd"]; eq.append(equity)
    for ts in sorted(groups):
        ready=[x for x in pending if x[0]<=ts]; pending=[x for x in pending if x[0]>ts]
        for _,i,e in sorted(ready,key=lambda z:z[0]):
            r=e["costScenarios"]["STRESS"]["netResultR"]
            for name in experts:
                if flags[i].get(name): hists[name].append(r)
        flush(ts)
        green={}
        for name in experts:
            h=hists[name][-hwin:]; ex=sum(h)/len(h) if h else 0.0; p=pf(h)
            green[name]=(len(h)>=hmin and ex>hp["minStressExpectancyRExclusive"] and p>=hp["minStressProfitFactor"])
            if green[name]: expert_green_counts[name]+=1
        raw_group=groups[ts]
        ranked=[]
        for i,e in raw_group:
            for name in experts:
                if flags[i].get(name): expert_qual_counts[name]+=1
            votes=[name for name in experts if flags[i].get(name) and green[name]]
            if len(votes) >= POLICY["entryProof"]["minHealthyExpertVotes"]:
                ranked.append((i,e,votes))
        ranked.sort(key=lambda z:(-len(z[2]),-z[1]["structureScore"],-z[1]["riskFraction"],z[1]["symbol"]))
        for i,e,votes in ranked:
            net_r=e["costScenarios"][scenario]["netResultR"]; selected_r.append(net_r)
            if len(active)>=POLICY["risk"]["maxConcurrent"]: continue
            if POLICY["risk"]["onePerSymbol"] and any(p["symbol"]==e["symbol"] for p in active): continue
            risk_usd=equity*POLICY["risk"]["riskPctEquity"]/100.0
            open_risk=sum(p["riskUsd"] for p in active)
            if open_risk+risk_usd > equity*POLICY["risk"]["maxOpenRiskPctEquity"]/100.0 + 1e-12: continue
            notional=risk_usd/e["riskFraction"]; margin=notional/POLICY["risk"]["leverageMarginOnly"]
            if sum(p["marginUsd"] for p in active)+margin > equity*POLICY["risk"]["maxMarginUtilizationPct"]/100.0: continue
            pos={"timestampMs":ts,"closeTs":e["closeTs"],"symbol":e["symbol"],"direction":e["direction"],"structureStatus":e["structureStatus"],
                 "structureScore":e["structureScore"],"riskFraction":e["riskFraction"],"healthyExpertVotes":votes,"voteCount":len(votes),
                 "riskPctEquity":POLICY["risk"]["riskPctEquity"],"riskUsd":risk_usd,"leverage":POLICY["risk"]["leverageMarginOnly"],
                 "marginUsd":margin,"netResultR":net_r,"pnlUsd":risk_usd*net_r,"exitReason":e["exitReason"]}
            active.append(pos); trades.append(pos); vote_counts[str(len(votes))]=vote_counts.get(str(len(votes)),0)+1
            max_open=max(max_open,sum(p["riskUsd"] for p in active)/equity*100.0); max_margin=max(max_margin,sum(p["marginUsd"] for p in active)/equity*100.0)
        for i,e in raw_group: pending.append((e["closeTs"],i,e))
    flush(float("inf"))
    pnl=[p["pnlUsd"] for p in trades]; wins=sum(x>0 for x in pnl); losses=sum(x<0 for x in pnl)
    gw=sum(x for x in pnl if x>0); gl=-sum(x for x in pnl if x<0); usdpf=gw/gl if gl>0 else (99.0 if gw>0 else 0.0)
    taken_r=[p["netResultR"] for p in trades]
    return {"scenario":scenario,"startingEquityUsd":STARTING_EQUITY,"endingEquityUsd":round(equity,6),"returnPct":round((equity/STARTING_EQUITY-1)*100,4),
            "maxDrawdownPct":round(max_drawdown_pct(eq),4),"profitFactorUsd":round(usdpf,6),"tradesTaken":len(trades),"wins":wins,"losses":losses,
            "winRatePct":round(wins/len(trades)*100,4) if trades else 0.0,"takenTradeExpectancyR":round(sum(taken_r)/len(taken_r),6) if taken_r else 0.0,
            "takenTradeCumulativeR":round(sum(taken_r),6),"selectedEntryCountBeforePortfolio":len(selected_r),
            "selectedEntryExpectancyR":round(sum(selected_r)/len(selected_r),6) if selected_r else 0.0,"selectedEntryCumulativeR":round(sum(selected_r),6),
            "maxOpenRiskPctObserved":round(max_open,6),"maxMarginUtilizationPct":round(max_margin,6),"voteCounts":vote_counts,
            "expertQualifiedSignalCounts":expert_qual_counts,"expertGreenTimestampCounts":expert_green_counts,"trades":trades}

def block_run(name:str,root:Path)->Dict[str,Any]:
    ev=build_events(root/"artifacts"/"v4_replay_signals.json",root/"frozen_dataset"/"data")
    return {"name":name,"signalCount":len(ev),"BASE":simulate(ev,"BASE"),"STRESS":simulate(ev,"STRESS")}

def consumed_pass(results:Dict[str,Any])->bool:
    productive=0
    for b,x in results.items():
        s=x["STRESS"]
        if s["endingEquityUsd"] < CONSUMED_GATE["allBlocksEndingEquityAtLeast"]: return False
        if s["tradesTaken"]>0:
            if s["takenTradeExpectancyR"] < CONSUMED_GATE["allTradedBlocksStressExpectancyRAtLeast"]: return False
            if s["profitFactorUsd"] < CONSUMED_GATE["allTradedBlocksStressProfitFactorAtLeast"]: return False
        if s["tradesTaken"] >= CONSUMED_GATE["productiveBlockMinTrades"] and s["selectedEntryExpectancyR"]>0: productive += 1
        if s["maxDrawdownPct"] > CONSUMED_GATE["maxStressDrawdownPct"]: return False
    return productive >= CONSUMED_GATE["productiveBlocksAtLeast"]

def fresh_pass(base,stress)->bool:
    return (base["endingEquityUsd"]>=FRESH_GATE["baseEndingEquityAtLeast"] and stress["endingEquityUsd"]>=FRESH_GATE["stressEndingEquityAtLeast"]
            and stress["profitFactorUsd"]>=FRESH_GATE["stressProfitFactorUsdAtLeast"] and stress["takenTradeExpectancyR"]>FRESH_GATE["stressEntryExpectancyRAbove"]
            and min(base["tradesTaken"],stress["tradesTaken"])>=FRESH_GATE["minTradesTaken"] and base["maxDrawdownPct"]<=FRESH_GATE["baseMaxDrawdownPctAtMost"]
            and stress["maxDrawdownPct"]<=FRESH_GATE["stressMaxDrawdownPctAtMost"] and max(base["maxOpenRiskPctObserved"],stress["maxOpenRiskPctObserved"])<=FRESH_GATE["maxOpenRiskPctAtMost"]+1e-9
            and max(base["maxMarginUtilizationPct"],stress["maxMarginUtilizationPct"])<=FRESH_GATE["maxMarginUtilizationPctAtMost"]+1e-9)

def cmd_consumed(args):
    roots={"DEV":Path(args.dev),"OOS1":Path(args.oos1),"OOS2":Path(args.oos2),"OOS3":Path(args.oos3),"OOS4":Path(args.oos4)}
    results={k:block_run(k,r) for k,r in roots.items()}
    out={"version":VERSION,"mode":"CONSUMED_DEV_OOS1_OOS2_OOS3_OOS4_DIAGNOSTIC_ONLY","policy":POLICY,"policyFingerprintSha256":policy_fingerprint(),
         "consumedGate":CONSUMED_GATE,"results":results,"decision":"LOCK_V5_EXPERT_ENTRY_FOR_FRESH_OOS5" if consumed_pass(results) else "STOP_BEFORE_OOS5",
         "integrity":{"consumedDataOnly":True,"noOos5Read":True,"noCoinDirectionStatusManualExclusions":True,"productionFilesModified":False,"scannerEnabled":False,"paperOrdersEnabled":False,"realOrdersEnabled":False}}
    Path(args.output).parent.mkdir(parents=True,exist_ok=True); Path(args.output).write_text(json.dumps(out,indent=2),encoding="utf-8"); print(json.dumps(out,indent=2))

def cmd_fresh(args):
    lock=json.loads(Path(args.lock).read_text(encoding="utf-8"))
    if lock.get("decision")!="LOCK_V5_EXPERT_ENTRY_FOR_FRESH_OOS5": raise RuntimeError(f"V5 not locked: {lock.get('decision')}")
    if lock.get("policyFingerprintSha256")!=policy_fingerprint(): raise RuntimeError("Policy fingerprint drifted")
    m=json.loads(Path(args.manifest).read_text(encoding="utf-8")); expected={"datasetStart":"2023-05-17","replayStart":"2023-08-25","replayEnd":"2023-12-02","datasetEnd":"2023-12-03"}
    if m.get("status") != "FROZEN_EXACT_PASS": raise RuntimeError(f"OOS5 dataset status is not exact: {m.get('status')}")
    for k,d in expected.items():
        if not str(m.get("layout",{}).get(k,"")).startswith(d): raise RuntimeError(f"OOS5 boundary mismatch {k}")
    block=block_run("FRESH_OOS5",Path(args.root)); passed=fresh_pass(block["BASE"],block["STRESS"])
    out={"version":VERSION,"mode":"FRESH_OOS5_LOCKED_ENTRY_VALIDATION_ONLY","dataset":{"id":m.get("datasetId"),"rootContentSha256":m.get("rootContentSha256"),"layout":m.get("layout")},
         "lockedPolicyFingerprintSha256":policy_fingerprint(),"lockedPolicy":POLICY,"preregisteredFreshGate":FRESH_GATE,"result":block,
         "decision":"PROMOTE_TO_EXIT_RESEARCH" if passed else "HOLD_RESEARCH_ONLY",
         "integrity":{"freshOos5ChronologicallyDisjointFromOos4":True,"policyLockedBeforeOos5":True,"pointInTimeOnly":True,"productionFilesModified":False,"scannerEnabled":False,"paperOrdersEnabled":False,"realOrdersEnabled":False},
         "nextStep":"Compare exits on these exact locked entries; PAPER remains disabled." if passed else "Do not tune on OOS5. Entry architecture remains research-only."}
    Path(args.output).parent.mkdir(parents=True,exist_ok=True); Path(args.output).write_text(json.dumps(out,indent=2),encoding="utf-8"); print(json.dumps(out,indent=2))

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd",required=True)
    c=sub.add_parser("consumed");
    for x in ["dev","oos1","oos2","oos3","oos4","output"]: c.add_argument(f"--{x}",required=True)
    c.set_defaults(func=cmd_consumed)
    f=sub.add_parser("fresh");
    for x in ["lock","root","manifest","output"]: f.add_argument(f"--{x}",required=True)
    f.set_defaults(func=cmd_fresh)
    a=ap.parse_args(); a.func(a)
if __name__=="__main__": main()
