import asyncio, edge_tts
async def t():
    comm = edge_tts.Communicate('Halo anak-anak! Hari ini kita mau belajar penjumlahan tambah satu.', 'id-ID-GadisNeural')
    await comm.save('test.wav')
    print('OK')
asyncio.run(t())
