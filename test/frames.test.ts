/**
 * 动图拆帧：报 bug 的人最爱录动图，而动图的信息全在时序里。
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFrames, extractFrames, looksAnimated, MAX_FRAMES } from '../src/core/frames.js'

const dir = () => mkdtempSync(join(tmpdir(), 'frames-'))
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** 造一个真 GIF：20 帧，纯色轮换 */
function makeGif(path: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=2', path])
}

describe('认出动图', () => {
  it('飞书把动图当 image 发、我们存成 .png —— 也要认出来', () => {
    if (!hasFfmpeg) return
    const d = dir()
    const gif = join(d, 'x.gif')
    makeGif(gif)
    // 故意改成 .png，模拟线上的命名
    const asPng = join(d, 'om_123.png')
    writeFileSync(asPng, require('node:fs').readFileSync(gif))
    expect(looksAnimated(asPng)).toBe(true)
  })

  it('真的静态 PNG 不会被误判', () => {
    if (!hasFfmpeg) return
    const d = dir()
    const png = join(d, 'still.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=32x32:duration=0.1', '-frames:v', '1', png])
    expect(looksAnimated(png)).toBe(false)
  })

  it('msgType=media 直接认', () => {
    expect(looksAnimated('/nope/whatever.bin', 'media')).toBe(true)
  })
})

describe('拆帧', () => {
  it('从头到尾均匀抽，不是只抽前几帧', async () => {
    if (!hasFfmpeg) return
    const d = dir()
    const gif = join(d, 'a.gif')
    makeGif(gif)
    const out = await extractFrames(gif, join(d, 'frames'))
    expect(out).toBeTruthy()
    expect(out!.files.length).toBeGreaterThan(1)
    expect(out!.files.length).toBeLessThanOrEqual(MAX_FRAMES)
    for (const f of out!.files) expect(existsSync(join(out!.dir, f))).toBe(true)
    // 文件名有序，模型才能按顺序看
    expect([...out!.files].sort()).toEqual(out!.files)
  })

  it('拆不动就返回 undefined，不抛异常（调用方退回当静态图看）', async () => {
    const d = dir()
    const bad = join(d, 'notmedia.gif')
    writeFileSync(bad, 'this is not a gif')
    expect(await extractFrames(bad, join(d, 'f'))).toBeUndefined()
  })

  it('文件不存在也不炸', async () => {
    expect(await extractFrames('/definitely/not/here.gif', '/tmp/nope')).toBeUndefined()
  })
})

describe('给模型的提示', () => {
  it('逼它先按时序描述再下结论，并且把解释不了的单独说', () => {
    const t = describeFrames('downloads/x-frames', { dir: '/x', files: ['f01.png', 'f02.png'], totalFrames: 20, durationSec: 2 }, '动图')
    expect(t).toContain('按文件名顺序')
    expect(t).toContain('只描述，不解释')
    expect(t).toContain('分开说')
    expect(t).toContain('f01.png')
  })
})
