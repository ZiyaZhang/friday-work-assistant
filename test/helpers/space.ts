/** 测试里构造一等对象层（空间 / 联盟 / 判定），和 src/index.ts 的顺序一致。 */
import type { DatabaseSync } from 'node:sqlite'
import { Circles } from '../../src/core/circles.js'
import { dmSpaceId, spaceScope, Spaces } from '../../src/core/space.js'
import { PolicyService } from '../../src/core/policy.js'

/** 断言用：这个群的记忆/待办作用域（空间已经存在时就是它的）。 */
export function chatScope(db: DatabaseSync, chatId: string): string {
  return spaceScope(new Spaces(db).ensure({ kind: 'group', chatId }).id)
}

/** 断言用：这个人私聊的作用域。 */
export function dmScope(openId: string): string {
  return spaceScope(dmSpaceId(openId))
}

export function spaceDeps(db: DatabaseSync, opts: { admins?: string[]; mode?: 'safe' | 'auto' | 'deny' } = {}): { circles: Circles; spaces: Spaces; policy: PolicyService } {
  const circles = new Circles(db)
  const spaces = new Spaces(db)
  const policy = new PolicyService(spaces, { admins: opts.admins ?? [], mode: opts.mode })
  return { circles, spaces, policy }
}
