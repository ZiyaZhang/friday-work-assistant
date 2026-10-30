import type { Registry, SessionRow } from './registry.js'
import type { RoutineStore } from './routines.js'
import type { Spaces } from './space.js'

/** 单库持久状态先提交，再中止外部运行；中止失败也不能恢复接入或发布资格。 */
export class SpaceLifecycle {
  constructor(private readonly deps: {
    spaces: Spaces
    registry: Registry
    routines?: RoutineStore
    /** 在 pauseForSpace 之后、同一事务里结清这个空间里不再等待的职责指针（授权提醒按人结清） */
    settlePointers?(spaceId: string, chatId: string): number
    stopExecutions?(sessions: SessionRow[]): void
    stopRuntime(sessions: SessionRow[]): Promise<void>
  }) {}

  async stop(spaceId: string): Promise<{ stoppedRoutines: number }> {
    const { spaces, registry, routines } = this.deps
    const space = spaces.get(spaceId)
    if (!space?.chatId) throw new Error('找不到当前群绑定')
    let sessions: SessionRow[]
    let stoppedRoutines: number
    registry.db.exec('SAVEPOINT stop_space')
    try {
      spaces.archive(spaceId)
      stoppedRoutines = routines?.pauseForSpace(spaceId, space.chatId) ?? 0
      this.deps.settlePointers?.(spaceId, space.chatId)
      sessions = registry.invalidateChat(space.chatId, 'space_disabled')
      this.deps.stopExecutions?.(sessions)
      registry.db.exec('RELEASE SAVEPOINT stop_space')
    } catch (err) {
      registry.db.exec('ROLLBACK TO SAVEPOINT stop_space')
      registry.db.exec('RELEASE SAVEPOINT stop_space')
      throw err
    }
    await this.deps.stopRuntime(sessions)
    return { stoppedRoutines }
  }
}
