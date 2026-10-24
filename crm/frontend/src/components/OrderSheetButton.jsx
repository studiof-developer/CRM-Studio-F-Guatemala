import { lazy, Suspense, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { showSuccess } from './Toast.jsx';

// "Crear ficha de pedido" desde el chat del cliente: abre el asistente ya con el cliente puesto y, en el paso de pagos, ofrece los
// comprobantes que ese cliente mandó por el chat. Se carga solo al usarse (el asistente trae el catálogo y el resto de la logística).
const SheetWizard = lazy(() => import('./logistics/SheetWizard.jsx'));

export default function OrderSheetButton({ customer }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!customer?.id}
        onClick={() => setOpen(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-greige transition-colors hover:bg-black/[0.05] hover:text-accent dark:hover:bg-white/[0.08] disabled:opacity-50"
        aria-label="Crear ficha de pedido"
        title="Crear ficha de pedido para este cliente"
      >
        <ClipboardList size={18} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <SheetWizard customer={customer} onClose={(id) => { setOpen(false); if (id) showSuccess('Ficha guardada. La encuentras en Pedidos → Fichas de pedido'); }} />
        </Suspense>
      )}
    </>
  );
}
