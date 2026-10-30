/**
 * 个人授权的最后一步：拿 code 换 token，然后确认换回来的确实是发起的那个人。
 *
 * 三个入口共用：本机回调、公网 Worker 中转、私聊粘贴回调链接。
 *
 * 这一步里有两件事很容易在新入口上被漏掉，而漏掉都不报错：
 * 1. `whoAmI` 核对——人可以在授权页上换一个账号登录，换回来的 token 就是**别人的**。
 *    不核对的话，Friday 会用 B 的身份去读 A 要求盯的群。
 * 2. 授权成功后要把因为缺授权而暂停的关注任务接回去。漏了就是"授权了但还是不动"。
 *
 * 所以规则是：**换 token 这件事只有这一个实现**，入口只负责把结果讲成自己那种话
 * （网页讲成一张页，飞书讲成一句消息）。新增入口不需要知道上面这两件事存在。
 */
import { describeGrantedScope, OAuthConnectionError, type UserTokenStore, type UserToken } from './oauth.js'

export interface ConnectCompletionDeps {
  userTokens: UserTokenStore
  redirectUri: string
  /** 用换回来的 token 反查"这到底是谁"。 */
  whoAmI(accessToken: string): Promise<{ openId?: string; name?: string }>
  /** 授权成功后恢复此前因缺授权而暂停的关注任务。 */
  onCompleted?(openId: string): Promise<{ connected: boolean; resumed?: number; stillPaused?: number } | undefined>
  log: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; debug(msg: string, meta?: unknown): void }
}

export type ConnectOutcome =
  | { ok: true; openId: string; name: string; title: string; detail: string }
  | { ok: false; title: string; detail: string; status: number }

export async function completeConnection(
  deps: ConnectCompletionDeps,
  input: { code: string; state?: string; openId?: string; error?: string },
): Promise<ConnectOutcome> {
  if (input.error) {
    const owner = deps.userTokens.ownerOfState(input.state)
    if (!owner || input.openId && input.openId !== owner || !input.state || !deps.userTokens.denyAuthorization(input.state)) {
      return { ok: false, status: 400, title: '授权链接已失效', detail: '这张授权卡已过期或已处理。需要连接时，请回 Friday 私聊获取新卡。' }
    }
    return { ok: false, status: 200, title: input.error === 'access_denied' ? '本次未授权' : '本次授权未完成',
      detail: '本次没有增加个人权限，原有连接保持不变。需要继续原请求时，可以回 Friday 私聊重新连接。' }
  }
  if (!input.code) {
    return { ok: false, status: 400, title: '缺少授权码', detail: '地址里没有 code 参数。回飞书跟我说一声，我重新把授权卡发给你。' }
  }
  let token: UserToken
  try {
    token = await deps.userTokens.complete({ ...input, redirectUri: deps.redirectUri, verify: deps.whoAmI })
  } catch (err) {
    deps.log.warn('oauth completion failed')
    return { ok: false, status: 400, title: '授权失败', detail: err instanceof OAuthConnectionError
      ? `${err.message}。回飞书跟我说一声，我重新把授权卡发给你。`
      : '本次连接没有完成。请稍后回飞书获取新的授权卡，重新连接。' }
  }
  const name = token.name ?? ''
  deps.log.info('user connected', { openId: token.openId })
  let recovery: Awaited<ReturnType<NonNullable<ConnectCompletionDeps['onCompleted']>>>
  let recoveryFailed = false
  try { recovery = await deps.onCompleted?.(token.openId) }
  catch { recoveryFailed = true; deps.log.warn('authorization recovery failed') }
  if (recovery && !recovery.connected) return { ok: false, status: 409, title: '连接状态已变更',
    detail: '这次授权后连接已变更。请回飞书查看最新连接状态。' }
  const back = recovery?.resumed ? `已恢复 ${recovery.resumed} 个关注任务，将从保留的读取位置继续。` : ''
  const paused = recovery?.stillPaused ? `另有 ${recovery.stillPaused} 个关注任务仍缺所需权限，或空间已停用、绑定已变更，仍保持暂停。` : ''
  return { ok: true, openId: token.openId, name, title: '已连接',
    detail: `已连接${name ? '，' + name : ''}。${describeGrantedScope(token.scope)}${back}${paused}`
      + (recoveryFailed ? '暂停的关注任务暂未恢复，请回私聊检查任务状态。' : '') }
}
