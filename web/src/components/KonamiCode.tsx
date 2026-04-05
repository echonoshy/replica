import { useEffect, useState } from 'react'
import confetti from 'canvas-confetti'

const KONAMI_CODE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
]

export function KonamiCode() {
  const [inputSequence, setInputSequence] = useState<string[]>([])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key
      
      setInputSequence((prev) => {
        const newSequence = [...prev, key]
        // Keep only the last N characters where N is the length of the Konami code
        if (newSequence.length > KONAMI_CODE.length) {
          newSequence.shift()
        }
        
        // Check if the sequence matches
        if (newSequence.join(',') === KONAMI_CODE.join(',')) {
          triggerEasterEgg()
          return [] // Reset after triggering
        }
        
        return newSequence
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const triggerEasterEgg = () => {
    // 1. Playful Confetti
    const duration = 3 * 1000
    const end = Date.now() + duration

    const frame = () => {
      confetti({
        particleCount: 5,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ['#ff4911', '#c4a1ff', '#ffd83d', '#ff3366']
      })
      confetti({
        particleCount: 5,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ['#ff4911', '#c4a1ff', '#ffd83d', '#ff3366']
      })

      if (Date.now() < end) {
        requestAnimationFrame(frame)
      }
    }
    frame()

    // 2. Barrel Roll Effect on the body
    document.body.style.transition = 'transform 1s ease-in-out'
    document.body.style.transform = 'rotate(360deg)'
    
    setTimeout(() => {
      document.body.style.transition = 'none'
      document.body.style.transform = 'none'
    }, 1000)
  }

  return null // This is a logic-only component
}
