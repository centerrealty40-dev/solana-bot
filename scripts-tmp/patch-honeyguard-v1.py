from pathlib import Path
import re

path = Path("/opt/solana-alpha/scripts-tmp/live-paper-trader.ts")
s = path.read_text(encoding="utf-8")

# --- 1) Filter calibration (anti-rug v2 defaults) ---
s = re.sub(r"MIN_UNIQUE_BUYERS:\s*[\d.]+,", "MIN_UNIQUE_BUYERS: 8,", s)
s = re.sub(r"MIN_BUY_SOL:\s*[\d.]+,", "MIN_BUY_SOL: 1.5,", s)
s = re.sub(r"MIN_BUY_SELL_RATIO:\s*[\d.]+,", "MIN_BUY_SELL_RATIO: 0.7,", s)
s = re.sub(r"MAX_TOP_BUYER_SHARE:\s*[\d.]+,", "MAX_TOP_BUYER_SHARE: 0.60,", s)
s = re.sub(r"MIN_BC_PROGRESS:\s*[\d.]+,", "MIN_BC_PROGRESS: 0.10,", s)

if "MAX_BUY_SELL_RATIO" not in s:
    s = s.replace("MIN_BUY_SELL_RATIO: 0.7,", "MIN_BUY_SELL_RATIO: 0.7,\n  MAX_BUY_SELL_RATIO: 1.3,", 1)

# --- 2) Evaluate() hardening ---
old_line = "if (m.sumSellSol > 0 && m.sumBuySol / m.sumSellSol < FILTERS.MIN_BUY_SELL_RATIO) r.push(`bs<${FILTERS.MIN_BUY_SELL_RATIO}`);"
if old_line in s:
    s = s.replace(
        old_line,
        "const buySellRatio = m.sumSellSol > 0 ? (m.sumBuySol / m.sumSellSol) : 999;\n"
        "  const sellBuyRatio = m.sumBuySol > 0 ? (m.sumSellSol / m.sumBuySol) : 0;\n"
        "  if (buySellRatio < FILTERS.MIN_BUY_SELL_RATIO) r.push(`bs<${FILTERS.MIN_BUY_SELL_RATIO}`);\n"
        "  if (buySellRatio > FILTERS.MAX_BUY_SELL_RATIO) r.push(`bs>${FILTERS.MAX_BUY_SELL_RATIO}`);\n"
        "  // Heatmap-driven anti-rug pattern: many buyers, distributed buys, but weak sell support.\n"
        "  if (m.uniqueBuyers >= 15 && m.topBuyerShare < 0.25 && sellBuyRatio < 1.0) r.push('rug_farm_pattern');"
    )
elif "rug_farm_pattern" not in s:
    # Fallback insertion near top-share check if code shape differs.
    anchor = "if (m.topBuyerShare > FILTERS.MAX_TOP_BUYER_SHARE) r.push(`top>${FILTERS.MAX_TOP_BUYER_SHARE * 100}%`);"
    if anchor in s:
        s = s.replace(
            anchor,
            "const buySellRatio = m.sumSellSol > 0 ? (m.sumBuySol / m.sumSellSol) : 999;\n"
            "  const sellBuyRatio = m.sumBuySol > 0 ? (m.sumSellSol / m.sumBuySol) : 0;\n"
            "  if (buySellRatio < FILTERS.MIN_BUY_SELL_RATIO) r.push(`bs<${FILTERS.MIN_BUY_SELL_RATIO}`);\n"
            "  if (buySellRatio > FILTERS.MAX_BUY_SELL_RATIO) r.push(`bs>${FILTERS.MAX_BUY_SELL_RATIO}`);\n"
            "  " + anchor + "\n"
            "  if (m.uniqueBuyers >= 15 && m.topBuyerShare < 0.25 && sellBuyRatio < 1.0) r.push('rug_farm_pattern');"
        )

# --- 3) Log line includes max bs ---
old_log = "console.log(`filters: buyers≥${FILTERS.MIN_UNIQUE_BUYERS}, buy_sol≥${FILTERS.MIN_BUY_SOL}, top≤${FILTERS.MAX_TOP_BUYER_SHARE * 100}%, bc∈[${FILTERS.MIN_BC_PROGRESS * 100}..${FILTERS.MAX_BC_PROGRESS * 100}]%`);"
if old_log in s:
    s = s.replace(
        old_log,
        "console.log(`filters: buyers≥${FILTERS.MIN_UNIQUE_BUYERS}, buy_sol≥${FILTERS.MIN_BUY_SOL}, bs∈[${FILTERS.MIN_BUY_SELL_RATIO}..${FILTERS.MAX_BUY_SELL_RATIO}], top≤${FILTERS.MAX_TOP_BUYER_SHARE * 100}%, bc∈[${FILTERS.MIN_BC_PROGRESS * 100}..${FILTERS.MAX_BC_PROGRESS * 100}]%`);"
    )

path.write_text(s, encoding="utf-8")
print("OK: honeyguard_v1 patched")
