import { useState } from 'react';
import { ShieldCheck, Search } from 'lucide-react';
import TabbedPage from './TabbedPage.jsx';
import Audit from './Audit.jsx';
import ChatAnalysis from './ChatAnalysis.jsx';

// Auditoría y Análisis de chats juntos (antes eran dos entradas del menú). /auditoria y /analisis abren la pestaña que les toca.
const TABS = [{ key: 'auditoria', label: 'Auditoría', icon: ShieldCheck }, { key: 'analisis', label: 'Análisis de chats', icon: Search }];
const FROM_PATH = { '/auditoria': 'auditoria', '/analisis': 'analisis' };

export default function SupervisionPage({ onOpenConversation }) {
  const [tab, setTab] = useState(() => FROM_PATH[window.location.pathname] ?? 'auditoria');
  return (
    <>
      <TabbedPage tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'auditoria' && <Audit onOpenConversation={onOpenConversation} />}
      {tab === 'analisis' && <ChatAnalysis onOpenConversation={onOpenConversation} />}
    </>
  );
}
