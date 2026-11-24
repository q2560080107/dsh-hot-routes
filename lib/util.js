/** 纯工具函数：超时、冻结、安全错误、深拷贝。 */
export function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(String(label ?? 'operation') + ' timed out after ' + ms + 'ms'))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function safeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    return Object.freeze(value)
  }
  return value
}

export function routeKey(route) {
  return String(route.provider) + '\u0000' + String(route.model)
}
