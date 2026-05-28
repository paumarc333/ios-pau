import { useState } from 'react'
import ChatScreen from './screens/ChatScreen'
import BodyScreen from './screens/BodyScreen'
import MarketsScreen from './screens/MarketsScreen'
import FeedScreen from './screens/FeedScreen'
import JournalScreen from './screens/JournalScreen'
import BottomNav from './components/BottomNav'
import './index.css'

type Tab = 'chat' | 'body' | 'markets' | 'feed' | 'journal'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chat')

  return (
    <div className="app">
      <div style={{ flex: 1, minHeight: 0, paddingBottom: 90 }}>
        {activeTab === 'chat'    && <ChatScreen isActive={true} />}
        {activeTab === 'body'    && <BodyScreen />}
        {activeTab === 'markets' && <MarketsScreen />}
        {activeTab === 'feed'    && <FeedScreen />}
        {activeTab === 'journal' && <JournalScreen />}
      </div>
      <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  )
}
