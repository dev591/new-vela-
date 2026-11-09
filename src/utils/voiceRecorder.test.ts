import { describe, expect, it } from 'vitest'
import { encodeWav } from './voiceRecorder'

// jsdom's Blob has no arrayBuffer(), so read it the old way.
const read = (blob: Blob) => new Promise<ArrayBuffer>(res => { const f = new FileReader(); f.onload = () => res(f.result as ArrayBuffer); f.readAsArrayBuffer(blob) })
const text = (b: DataView, off: number, n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(b.getUint8(off + i))).join('')

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono 16-bit WAV header', async () => {
    const block = new Float32Array(128).fill(0.5)
    const wav = encodeWav([block, block], 256, 16000)
    const v = new DataView(await read(wav))
    expect(wav.type).toBe('audio/wav')
    expect(text(v, 0, 4)).toBe('RIFF'); expect(text(v, 8, 4)).toBe('WAVE'); expect(text(v, 36, 4)).toBe('data')
    expect(v.getUint16(22, true)).toBe(1)             // mono
    expect(v.getUint32(24, true)).toBe(16000)         // sample rate
    expect(v.getUint16(34, true)).toBe(16)            // bits per sample
    expect(v.getUint32(40, true)).toBe(256 * 2)       // data size
    expect(wav.size).toBe(44 + 256 * 2)
  })

  it('resamples 48 kHz audio down to 16 kHz (a third of the samples)', async () => {
    const wav = encodeWav([new Float32Array(4800)], 4800, 48000)
    const v = new DataView(await read(wav))
    expect(v.getUint32(40, true)).toBe(1600 * 2)
  })

  it('clamps loud samples instead of wrapping around', async () => {
    const wav = encodeWav([new Float32Array([2, -2])], 2, 16000)
    const v = new DataView(await read(wav))
    expect(v.getInt16(44, true)).toBe(32767); expect(v.getInt16(46, true)).toBe(-32768)
  })
})
