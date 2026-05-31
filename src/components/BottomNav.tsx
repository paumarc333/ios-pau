import { useEffect, useState } from 'react'
import { MessageCircle, Apple, TrendingUp, LayoutList, BookOpen } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

type Tab = 'chat' | 'body' | 'markets' | 'feed' | 'journal'

interface Props {
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
}

const tabs = [
  { id: 'chat',    icon: MessageCircle },
  { id: 'body',    icon: Apple },
  { id: 'markets', icon: TrendingUp },
  { id: 'feed',    icon: LayoutList },
  { id: 'journal', icon: BookOpen },
]

const NAV_STYLES = `
  .nav-icon-active path,
  .nav-icon-active circle,
  .nav-icon-active line,
  .nav-icon-active polyline,
  .nav-icon-active rect,
  .nav-icon-active ellipse {
    stroke: url(#nav-grad);
  }
`

export default function BottomNav({ activeTab, setActiveTab }: Props) {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const check = () => setHidden(document.body.style.getPropertyValue('--hide-tabbar') === '1')
    const observer = new MutationObserver(check)
    observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [])

  return (
    <AnimatePresence>
      {!hidden && (
    <>
      <style>{NAV_STYLES}</style>

      <svg width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
        <defs>
          <linearGradient
            id="nav-grad"
            gradientUnits="userSpaceOnUse"
            x1="0" y1="0" x2="24" y2="0"
            spreadMethod="repeat"
          >
            <stop offset="0%"   stopColor="#8B5CF6" />
            <stop offset="33%"  stopColor="#06B6D4" />
            <stop offset="67%"  stopColor="#EC4899" />
            <stop offset="100%" stopColor="#8B5CF6" />
            <animate attributeName="x1" from="0"  to="-24" dur="3s" repeatCount="indefinite" />
            <animate attributeName="x2" from="24" to="0"   dur="3s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
      </svg>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.2 }}
        style={{
          position: 'sticky',
          bottom: 'calc(20px + env(safe-area-inset-bottom))',
          zIndex: 50,
          margin: '0 auto',
          width: 'fit-content',
        }}>
        <nav style={{
          background: 'rgba(15,15,20,0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '0.5px solid rgba(255,255,255,0.12)',
          borderRadius: 32,
          padding: '8px 20px',
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          height: 56,
          width: 320,
          gap: 8,
          position: 'relative',
        }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <div key={tab.id} style={{ position: 'relative', flex: 1 }}>
                {isActive && (
                  <motion.div
                    layoutId="tab-selector"
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'rgba(255,255,255,0.12)',
                      backdropFilter: 'blur(10px)',
                      WebkitBackdropFilter: 'blur(10px)',
                      border: '0.5px solid rgba(255,255,255,0.15)',
                      borderRadius: '26px',
                      zIndex: 0,
                    }}
                  />
                )}
                <motion.button
                  onClick={() => setActiveTab(tab.id as Tab)}
                  whileTap={{ scale: 0.85 }}
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '10px 0',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <tab.icon
                    size={20}
                    color={isActive ? '#ffffff' : 'rgba(255,255,255,0.35)'}
                    strokeWidth={isActive ? 1.5 : 1.2}
                    className={isActive ? 'nav-icon-active' : ''}
                  />
                </motion.button>
              </div>
            )
          })}
        </nav>
      </motion.div>
    </>
      )}
    </AnimatePresence>
  )
}
