/** 进程内测试运行器：依次执行全部场景并报告结果。 */
const lib = await import('./hot-refresher.test.mjs')
let pass = 0, fail = 0
const names = [['T1', lib], ['T2', lib], ['T3', lib], ['T4', lib], ['T5', lib], ['T6', lib], ['T7', lib], ['T8', lib], ['T9', lib], ['T10', lib]]
for (const [name, mod] of names) {
  const fn = mod[name]
  if (typeof fn !== 'function') { console.log('SKIP ' + name); continue }
  try { await fn(); console.log('PASS ' + name); pass += 1 }
  catch (error) { console.log('FAIL ' + name + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : String(error))); fail += 1 }
}
console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===')
if (fail > 0) process.exitCode = 1
