import { useState, useEffect } from 'react'

/**
 * 返回终端尺寸，监听 resize 事件自动更新
 */
export function useTerminalSize(): { cols: number; rows: number } {
  const [size, setSize] = useState(() => ({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }))

  useEffect(() => {
    const onResize = () => {
      setSize({
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      })
    }
    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize) }
  }, [])

  return size
}
