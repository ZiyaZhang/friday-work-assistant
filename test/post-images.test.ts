/**
 * 图文混排里的图片要取得到。
 *
 * 真机上撞到的：用户发了一张截图 + 一句「把这个 Beta 标签改成实验性，提到 deepseek-harness 并 request 我 review」，
 * Friday 回「截图我读不到（这条私聊消息里的图片没能取到）」，然后停下来问是哪个 Beta 标签。
 *
 * 诚实是对的，但这件事本来就该能做到。根因有两处，都在同一条路上：
 * 1. `extractAttachment` 只在 `msgType === 'image'` 时取 `image_key`，**post 一律不取**；
 * 2. `attachmentsNote` 对 `post` 直接 `return undefined`，连试都不试。
 *
 * 而「截图 + 一句话」正是人最常见的提问方式，飞书把它打成一条 `post`。
 * 更糟的是正文里会渲染成 `[图片 img_v3_xxx]`——模型**看得见有图、看得见 key，却读不到内容**。
 */
import { describe, expect, it } from 'vitest'
import { extractAttachment } from '../src/feishu/client.js'
import { inboundFromEvent } from '../src/feishu/mention.js'

/** 真实形状：图文混排是 { title, content: [[节点...]] }，图片是 tag='img' 的节点。 */
function postContent(nodes: unknown[][]) {
  return JSON.stringify({ title: '', content: nodes })
}

describe('图文混排里的图片 key', () => {
  it('截图 + 一句话：图片 key 取得到', () => {
    const content = postContent([
      [{ tag: 'img', image_key: 'img_v3_aaa' }],
      [{ tag: 'text', text: '把这个 Beta 标签改成实验性' }],
    ])
    expect(extractAttachment('post', content)).toMatchObject({ imageKey: 'img_v3_aaa', imageKeys: ['img_v3_aaa'] })
  })

  it('多张图按出现顺序全取，并且去重', () => {
    const content = postContent([
      [{ tag: 'img', image_key: 'img_1' }, { tag: 'text', text: '这两个' }, { tag: 'img', image_key: 'img_2' }],
      [{ tag: 'img', image_key: 'img_1' }],
    ])
    expect(extractAttachment('post', content).imageKeys).toEqual(['img_1', 'img_2'])
  })

  it('两种语言包裹形状都认（zh_cn/en_us 外层）', () => {
    const content = JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'img', image_key: 'img_zh' }]] } })
    expect(extractAttachment('post', content).imageKeys).toEqual(['img_zh'])
  })

  it('纯文字的 post 不谎报有图', () => {
    expect(extractAttachment('post', postContent([[{ tag: 'text', text: '就一句话' }]]))).toEqual({})
  })

  it('坏掉的 content 不抛异常', () => {
    expect(extractAttachment('post', 'not json')).toEqual({})
    expect(extractAttachment('post', JSON.stringify({ content: 'nope' }))).toEqual({})
    expect(extractAttachment('post', JSON.stringify({ content: [[{ tag: 'img' }]] }))).toEqual({})
  })

  it('单图消息（msgType=image）还是照旧，不受影响', () => {
    expect(extractAttachment('image', JSON.stringify({ image_key: 'img_single' })))
      .toEqual({ imageKey: 'img_single' })
  })

  it('入站事件里 imageKeys 会一路带到 InboundMessage 上', () => {
    const msg = inboundFromEvent({
      event_id: 'ev1',
      message: {
        message_id: 'om_1', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'post',
        create_time: String(Date.now()),
        content: postContent([[{ tag: 'img', image_key: 'img_v3_bbb' }], [{ tag: 'text', text: '看这个' }]]),
      },
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    })
    expect(msg.msgType).toBe('post')
    expect(msg.imageKeys).toEqual(['img_v3_bbb'])
    // 正文里仍然看得见占位，但现在不再是"看得见却读不到"
    expect(msg.text).toContain('img_v3_bbb')
  })
})
