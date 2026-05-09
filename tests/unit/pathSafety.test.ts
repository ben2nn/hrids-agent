import { describe, it, expect } from 'vitest'
import { checkWritePath, isDangerousRemovalPath } from '../../src/core/pathSafety.js'
import { homedir } from 'os'

describe('checkWritePath', () => {
  const cwd = '/home/user/project'

  it('普通相对路径安全', () => {
    expect(checkWritePath('src/index.ts', cwd)).toEqual({ safe: true })
  })

  it('普通绝对路径安全', () => {
    expect(checkWritePath('/tmp/test.txt', cwd)).toEqual({ safe: true })
  })

  it('拦截 $ 变量展开', () => {
    const result = checkWritePath('$HOME/evil.txt', cwd)
    expect(result.safe).toBe(false)
    expect((result as { safe: false; reason: string }).reason).toContain('$')
  })

  it('拦截 % 变量展开', () => {
    const result = checkWritePath('%USERPROFILE%/evil.txt', cwd)
    expect(result.safe).toBe(false)
    expect((result as { safe: false; reason: string }).reason).toContain('%')
  })

  it('拦截 ~user 变体', () => {
    const result = checkWritePath('~admin/evil.txt', cwd)
    expect(result.safe).toBe(false)
    expect((result as { safe: false; reason: string }).reason).toContain('tilde')
  })

  it('允许 ~/ 深层子目录路径', () => {
    // ~/file 会被拦截因为 dirname(homedir/file) === homedir
    expect(checkWritePath('~/test.txt', cwd).safe).toBe(false)
    // ~/subdir/file 应该安全
    expect(checkWritePath('~/documents/test.txt', cwd).safe).toBe(true)
  })

  it('禁止写入主目录根层级', () => {
    const home = homedir()
    const result = checkWritePath(home + '/test.txt', cwd)
    expect(result.safe).toBe(false)
    expect((result as { safe: false; reason: string }).reason).toContain('主目录')
  })

  it('禁止写入 .git 目录', () => {
    const result = checkWritePath('/tmp/project/.git/config', cwd)
    expect(result.safe).toBe(false)
    expect((result as { safe: false; reason: string }).reason).toContain('.git')
  })

  it('禁止写入 .git 目录本身', () => {
    const result = checkWritePath('/tmp/project/.git', cwd)
    expect(result.safe).toBe(false)
  })

  it('相对路径正确解析', () => {
    expect(checkWritePath('nested/deep/file.ts', cwd)).toEqual({ safe: true })
  })

  it('~+ 和 ~- 变体被拦截', () => {
    expect(checkWritePath('~+/dir', cwd).safe).toBe(false)
    expect(checkWritePath('~-/dir', cwd).safe).toBe(false)
  })

  it('~/ 深层子目录安全', () => {
    const result = checkWritePath('~/documents/project/test.txt', cwd)
    expect(result.safe).toBe(true)
  })
})

describe('isDangerousRemovalPath', () => {
  it('根目录 / 危险', () => {
    expect(isDangerousRemovalPath('/')).toBe(true)
  })

  it('通配符 * 危险', () => {
    expect(isDangerousRemovalPath('*')).toBe(true)
  })

  it('/* 结尾危险', () => {
    expect(isDangerousRemovalPath('/tmp/*')).toBe(true)
  })

  it('\\* 结尾危险', () => {
    expect(isDangerousRemovalPath('C:\\Users\\*')).toBe(true)
  })

  it('Windows 盘符根目录危险', () => {
    expect(isDangerousRemovalPath('C:\\')).toBe(true)
    expect(isDangerousRemovalPath('D:/')).toBe(true)
    expect(isDangerousRemovalPath('E:')).toBe(true)
  })

  it('用户主目录危险', () => {
    const home = homedir()
    expect(isDangerousRemovalPath(home)).toBe(true)
  })

  it('根目录直接子目录危险', () => {
    expect(isDangerousRemovalPath('/usr')).toBe(true)
    expect(isDangerousRemovalPath('/etc')).toBe(true)
    expect(isDangerousRemovalPath('/tmp')).toBe(true)
  })

  it('Windows 盘符直接子目录危险', () => {
    expect(isDangerousRemovalPath('C:\\Windows')).toBe(true)
    expect(isDangerousRemovalPath('C:\\Users')).toBe(true)
  })

  it('深层路径不危险', () => {
    expect(isDangerousRemovalPath('/tmp/project/node_modules')).toBe(false)
    expect(isDangerousRemovalPath('C:\\Users\\test\\file.txt')).toBe(false)
  })

  it('相对路径不危险', () => {
    expect(isDangerousRemovalPath('src/index.ts')).toBe(false)
    expect(isDangerousRemovalPath('./node_modules')).toBe(false)
  })

  it('Windows 反斜杠路径正确处理', () => {
    expect(isDangerousRemovalPath('C:\\')).toBe(true)
    expect(isDangerousRemovalPath('C:\\Users\\test')).toBe(false)
  })
})
