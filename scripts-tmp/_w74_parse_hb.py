import json, sys
for ln in sys.stdin:
    i = ln.find('{')
    if i < 0:
        continue
    try:
        o = json.loads(ln[i:])
    except Exception:
        continue
    st = o.get('stats',{})
    print(f"opened={st.get('opened',0)} skippedSafety={st.get('skippedSafety',0)} skippedPriceVerify={st.get('skippedPriceVerify','<missing>')} evaluated={st.get('evaluated',0)} open={o.get('open')}")
