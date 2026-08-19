import { CreditCard, Banknote, ArrowRightLeft, Landmark } from 'lucide-react';

export const PAID_METHOD_LABELS = {
  tarjeta: 'Tarjeta',
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
};

export const PAID_METHOD_ICONS = {
  tarjeta: CreditCard,
  efectivo: Banknote,
  transferencia: ArrowRightLeft,
  deposito: Landmark,
};

export const PAID_METHOD_ORDER = ['tarjeta', 'efectivo', 'transferencia', 'deposito'];
