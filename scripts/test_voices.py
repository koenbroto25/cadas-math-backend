import asyncio, edge_tts
async def t():
    voices = await edge_tts.list_voices()
    id_voices = [v for v in voices if v['Locale'].startswith('id-')]
    print('ID voices:', len(id_voices))
    for v in id_voices[:5]:
        print(' ', v['ShortName'], '-', v['Gender'])
asyncio.run(t())
