import json, asyncio, edge_tts, os, sys, time
from pathlib import Path

CACHE = Path(r"D:\local-rag-voice-bot\speed-math-master\audio\speech\cache")
REPORT = Path(r"D:\local-rag-voice-bot\speed-math-master\audio\speech\wav-quality-report.json")
EXERCISES = Path(r"D:\local-rag-voice-bot\cadas-app-backend\tmp-exercises.json")
VOICE = "id-ID-GadisNeural"
MAX_RETRIES = 3
RETRY_DELAY = 2

report = json.loads(REPORT.read_text())
exercises = json.loads(EXERCISES.read_text())
mp = {e["source_id"]: e for e in exercises}
issues = report.get("padding", []) + report.get("mismatch", [])
print(f"Issues: {len(issues)}, DB rows: {len(mp)}")

async def gen_one(text, out_path):
    for attempt in range(MAX_RETRIES):
        try:
            comm = edge_tts.Communicate(text, VOICE)
            await comm.save(str(out_path))
            return True
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                return False

async def main():
    ok = fail = skip = 0
    for i, item in enumerate(issues):
        src = item.get("src") or item.get("sourceId")
        kind = item.get("kind") or ("hint" if "_hint" in item.get("f", "") else "trick")
        base = f"{src}_{kind}"
        ex = mp.get(src)
        if not ex:
            skip += 1
            continue
        text = ex.get("hint_text") or ex.get("speech_text") if kind == "hint" else ex.get("quick_trick") or ex.get("speech_text")
        if not text:
            skip += 1
            continue
        out = CACHE / f"{base}.wav"
        success = await gen_one(text, out)
        if success:
            ok += 1
        else:
            fail += 1
            if fail <= 5:
                print(f"  FAIL: {base}")
        if ok % 50 == 0:
            print(f"  Progress: {ok} ok, {fail} fail, {skip} skip")
        await asyncio.sleep(0.1)
    print(f"\n=== DONE ===")
    print(f"OK: {ok}, FAIL: {fail}, SKIP: {skip}")

asyncio.run(main())
