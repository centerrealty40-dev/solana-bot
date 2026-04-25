import json
from pathlib import Path

# Inputs:
# - validate-grid.json OR enhanced-backtest.json output
# Assumptions per filled order:
# - slippage_pct: expected execution slippage
# - dex_fee_pct: protocol/pool fee
# - network_usd: gas+priority+failed retry amortized

FILE = Path("/opt/solana-alpha/data/validate-grid.json")
if not FILE.exists():
    FILE = Path("/opt/solana-alpha/data/enhanced-backtest.json")

data = json.loads(FILE.read_text())

slippage_pct = 1.5
dex_fee_pct = 0.30
network_usd = 0.03

# winner strategy usually has ~3 fills: buy + partial/final exits
fills_per_trade = 3
cost_pct_per_fill = slippage_pct + dex_fee_pct
cost_pct_total = cost_pct_per_fill * fills_per_trade

print(f"source={FILE}")
print(f"assumptions: slippage={slippage_pct}% dex_fee={dex_fee_pct}% fills={fills_per_trade} network=${network_usd}/fill")
print(f"gross haircut per trade = {cost_pct_total:.2f}% + ${(network_usd * fills_per_trade):.2f} network")
print()

if "train_winner" in data:
    tw = data["train_winner"]
    gross = tw["test"]["sum_pnl_usd"]
    trades = tw["test"]["trades"]
    gross_pct = tw["test"]["avg_pnl_pct"]
    net_pct = gross_pct - cost_pct_total
    net_usd = trades * (net_pct / 100.0) * 100 - trades * (network_usd * fills_per_trade)
    print("validate-grid test winner:")
    print(f"trades={trades} gross=${gross:.2f} gross_avg={gross_pct:.2f}%")
    print(f"net_avg={net_pct:.2f}%  net_total=${net_usd:.2f}")
else:
    # enhanced-backtest named leaderboard
    top = data.get("named", [])[0] if "named" in data else data.get("strategies", [])[0]
    if not top:
        raise SystemExit("no strategy rows found")
    trades = top["trades"]
    gross_pct = top["avg_pnl_pct"]
    gross = top["sum_pnl_usd"]
    net_pct = gross_pct - cost_pct_total
    net_usd = trades * (net_pct / 100.0) * 100 - trades * (network_usd * fills_per_trade)
    print(f"top strategy={top.get('id', '?')} {top.get('name', '')}")
    print(f"trades={trades} gross=${gross:.2f} gross_avg={gross_pct:.2f}%")
    print(f"net_avg={net_pct:.2f}%  net_total=${net_usd:.2f}")
