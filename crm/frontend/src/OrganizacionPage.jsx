import { useState } from 'react';
import { Building2, Store, Smartphone } from 'lucide-react';
import TabbedPage from './TabbedPage.jsx';
import Companies from './Companies.jsx';
import Brands from './Brands.jsx';
import WhatsappNumbers from './WhatsappNumbers.jsx';

// Empresas, marcas y líneas de WhatsApp en una sola pantalla (antes eran tres entradas del menú). Los enlaces viejos (/empresas, /marcas, /lineas) abren la pestaña que les toca.
const TABS = [{ key: 'empresas', label: 'Empresas', icon: Building2 }, { key: 'marcas', label: 'Marcas', icon: Store }, { key: 'lineas', label: 'Líneas de WhatsApp', icon: Smartphone }];
const FROM_PATH = { '/empresas': 'empresas', '/marcas': 'marcas', '/lineas': 'lineas' };

export default function OrganizacionPage() {
  const [tab, setTab] = useState(() => FROM_PATH[window.location.pathname] ?? 'empresas');
  return (
    <>
      <TabbedPage tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'empresas' && <Companies />}
      {tab === 'marcas' && <Brands />}
      {tab === 'lineas' && <WhatsappNumbers />}
    </>
  );
}
