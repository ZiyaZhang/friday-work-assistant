/**
 * 动图和视频拆帧。
 *
 * 用户报 bug 最省事的方式是录一段动图扔进群里。一张静态图只能看到某一瞬间，
 * 而「按钮为什么闪了一下」这种问题，**信息全在时序里**——先出现什么、
 * 鼠标移到哪、隔多久消失。不拆帧就等于只看了第一帧，然后开始猜。
 *
 * 做法：ffprobe 数出总帧数，按时间均匀挑最多 MAX_FRAMES 帧，一次 ffmpeg 全导出来。
 * 均匀挑而不是取前 N 帧——前 N 帧往往还没开始动。
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 最多抽几帧。再多模型也看不过来，而且每帧都要钱。 */
export const MAX_FRAMES = 8

export interface FrameSet {
  dir: string
  files: string[]
  totalFrames: number
  durationSec: number | null
}

/**
 * 这个文件值不值得拆帧（动图 / 视频）。
 *
 * **按文件头认，不按扩展名认**：飞书把动图当 image 发，下载下来我们命名成 `.png`，
 * 光看名字会以为是张静态图，然后只看第一帧——这正是最容易漏的那种 bug 报告。
 */
export function looksAnimated(path: string, msgType?: string): boolean {
  if (msgType === 'media') return true
  try {
    const fd = openSync(path, 'r')
    const head = Buffer.alloc(16)
    const n = readSync(fd, head, 0, 16, 0)
    closeSync(fd)
    if (n < 12) return false
    const ascii = head.toString('latin1')
    if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return true
    // 动态 WebP：RIFF....WEBP，且带 VP8X/ANIM 块
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return true
    // mp4 / mov：....ftyp
    if (ascii.slice(4, 8) === 'ftyp') return true
    // APNG 是 PNG 头 + acTL 块，光看前 16 字节认不出来，交给扩展名兜底
    return /\.(gif|mp4|mov|webm|avi|mkv|m4v|apng)$/i.test(path)
  } catch {
    return /\.(gif|mp4|mov|webm|avi|mkv|m4v|apng|webp)$/i.test(path)
  }
}

async function probeCount(src: string): Promise<{ frames: number; duration: number | null }> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,duration', '-of', 'csv=p=0', src], { timeout: 60_000 })
    const parts = stdout.trim().split(',')
    // 字段顺序会变，所以按「像时长的」和「像帧数的」来认，别按位置认
    let frames = 0
    let duration: number | null = null
    for (const p of parts) {
      const n = Number(p)
      if (!Number.isFinite(n)) continue
      if (Number.isInteger(n) && n > frames) frames = n
      if (!Number.isInteger(n)) duration = n
    }
    return { frames, duration }
  } catch {
    return { frames: 0, duration: null }
  }
}

/**
 * 拆帧到 `<destDir>`，返回实际导出的文件（已排序）。
 * 拆不动就返回 undefined——**不抛异常**，调用方退回"只当一张静态图看"。
 */
export async function extractFrames(src: string, destDir: string, max = MAX_FRAMES): Promise<FrameSet | undefined> {
  if (!existsSync(src)) return undefined
  try {
    mkdirSync(destDir, { recursive: true })
    const { frames, duration } = await probeCount(src)
    // 帧数数不出来（有些 gif 就是这样）→ 退化成按时间抽，1 fps 封顶 max 帧
    const filter = frames > 1 ? buildSelect(frames, max) : `fps=1`
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', filter, '-vsync', '0', '-frames:v', String(max), join(destDir, 'f%02d.png')], { timeout: 120_000 })
    const files = readdirSync(destDir).filter((f) => f.endsWith('.png')).sort()
    if (!files.length) return undefined
    return { dir: destDir, files, totalFrames: frames || files.length, durationSec: duration }
  } catch {
    return undefined
  }
}

/** 从 total 帧里均匀挑 max 帧的 ffmpeg select 表达式。 */
function buildSelect(total: number, max: number): string {
  const n = Math.min(max, total)
  const idx: number[] = []
  for (let i = 0; i < n; i += 1) idx.push(Math.round((i * (total - 1)) / Math.max(1, n - 1)))
  const uniq = [...new Set(idx)]
  return `select='${uniq.map((i) => `eq(n\\,${i})`).join('+')}'`
}

/** 给模型看的那段话。重点是**逼它先按时序描述，再下结论**。 */
export function describeFrames(rel: string, fs: FrameSet, kind: '动图' | '视频'): string {
  const dur = fs.durationSec ? `约 ${fs.durationSec.toFixed(1)} 秒、` : ''
  return (
    `发言人发了一段${kind}（${dur}共 ${fs.totalFrames} 帧），我按时间均匀抽了 ${fs.files.length} 帧，` +
    `已存到 \`${rel}/\`：${fs.files.join('、')}。\n` +
    `**按文件名顺序把每一帧都 read_image 看一遍**（第一帧是开头，最后一帧是结尾），然后：\n` +
    `1. 先把「发生了什么」按时序说出来——什么出现/消失、鼠标或焦点移到哪、大概隔了多久。这一步只描述，不解释。\n` +
    `2. 再去代码里找对应的逻辑，用第 1 步的现象去核对。\n` +
    `3. 能解释的和不能解释的**分开说**：「这段逻辑解释了它为什么会闪一下，但不解释他说的第二次也闪」。` +
    `别拿一个能解释一半的结论当根因。`
  )
}
