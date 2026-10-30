/** Shared by the host and Worker. No caller-supplied download URL is accepted. */
export const ARTIFACT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30_000
export class GitHubArtifactDownloadError extends Error {
  constructor(readonly code: 'invalid_input' | 'repository_denied' | 'redirect_rejected' | 'too_large' | 'upstream_failed' | 'unavailable' | 'invalid_response') {
    super(`GitHub 产物下载未完成：${code}`); this.name = 'GitHubArtifactDownloadError'
  }
}
export function validateArtifactArchive(repo: string, artifactId: number, maxBytes: number): void {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(artifactId) || artifactId <= 0 ||
    !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ARTIFACT_ARCHIVE_MAX_BYTES) throw new GitHubArtifactDownloadError('invalid_input')
}
/** GitHub's documented Actions artifact storage destinations. Location is used
 * only when returned by the fixed authenticated GitHub artifact endpoint.
 * https://docs.github.com/en/actions/reference/runners/github-hosted-runners#communication-requirements-for-github-hosted-runners */
export function artifactStorageLocation(value: unknown): string {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new GitHubArtifactDownloadError('redirect_rejected')
  let url: URL
  try { url = new URL(value) } catch { throw new GitHubArtifactDownloadError('redirect_rejected') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
    !(url.hostname === 'results-receiver.actions.githubusercontent.com' || /^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname))) {
    throw new GitHubArtifactDownloadError('redirect_rejected')
  }
  return url.href
}
export function validateArchiveLength(value: unknown, maxBytes: number): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new GitHubArtifactDownloadError('invalid_response')
  if (Number(value) > maxBytes) throw new GitHubArtifactDownloadError('too_large')
}
