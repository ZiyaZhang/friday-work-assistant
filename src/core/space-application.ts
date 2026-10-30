import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Space, Spaces } from './space.js'

export interface PresentationPatch {
  brevity?: 'short' | 'normal' | 'detailed'
  ack?: 'react' | 'none'
}
export class SpaceApplicationError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message) }
}

/** Only the fields being edited and their binding participate in this content version. */
export function presentationTag(space: Space): string {
  return createHash('sha256').update(JSON.stringify([space.id, space.kind, space.chatId, space.status,
    space.config.brevity ?? null, space.config.ack ?? null])).digest('hex')
}

/** Entrypoints authorize configuration first. Chat and console persist the same explicit preferences. */
export class SpaceApplication {
  constructor(private readonly deps: { db: DatabaseSync; spaces: Spaces }) {}

  configurePresentation(spaceId: string, patch: PresentationPatch, input: { actorOpenId?: string; expectedTag: string }) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => key !== 'brevity' && key !== 'ack') ||
      ('brevity' in patch && !['short', 'normal', 'detailed'].includes(patch.brevity!)) ||
      ('ack' in patch && !['react', 'none'].includes(patch.ack!))) {
      throw new SpaceApplicationError(400, 'invalid_preferences', '请提供有效的回答长度或状态反馈设置')
    }
    const { db, spaces } = this.deps
    db.exec('SAVEPOINT space_presentation')
    try {
      const space = spaces.get(spaceId)
      if (!space) throw new SpaceApplicationError(404, 'space_not_found', '空间已不存在')
      if (space.status !== 'active' || presentationTag(space) !== input.expectedTag) {
        throw new SpaceApplicationError(409, 'settings_changed', '空间设置已变化，请刷新后再修改')
      }
      const changed = Object.entries(patch).some(([key, value]) => space.config[key as keyof PresentationPatch] !== value)
      // Even an unchanged explicit preference is a choice for this person's future spaces.
      const updated = spaces.patchConfig(spaceId, patch, input.actorOpenId)!
      db.exec('RELEASE space_presentation')
      return { space: updated, tag: presentationTag(updated), changed }
    } catch (error) {
      db.exec('ROLLBACK TO space_presentation; RELEASE space_presentation')
      throw error
    }
  }
}
