/**
 * Generador gráfico de tarjetas de cotización en formato PNG usando HTML5 Canvas.
 * Diseñado con estética editorial de alta gama (Studio F / Basshert):
 * - Soporta 2x DPI para nitidez cristalina en pantallas de smartphones.
 * - Desglose de Referencia, Prenda (con Talla y Color), Cantidad, Precio Unitario, Descuento y Total.
 * - Soporte de costo de envío opcional, nota personalizada y destacado de Ahorro y Total a Pagar.
 */

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(parts[1]);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
}

export async function generateQuoteCardBlob({
  brandName = 'STUDIO F',
  quoteNumber = 'COT-2026-0001',
  advisorName = 'Asesor Studio F',
  customerName = 'Cliente',
  items = [],
  subtotal = 0,
  discountTotal = 0,
  shippingCost = 0,
  grandTotal = 0,
  customNote = '',
} = {}) {
  const safeBrand = String(brandName || 'STUDIO F').trim();
  const safeQuoteNum = String(quoteNumber || 'COT-2026-0001').trim();
  const safeAdvisor = String(advisorName || 'Asesor Studio F').trim();
  const safeCustomer = String(customerName || 'Cliente').trim();
  const safeItems = Array.isArray(items) ? items : [];
  const safeShipping = Math.max(0, Number(shippingCost) || 0);
  const safeNote = String(customNote || '').trim();

  const width = 840;
  const headerHeight = 220;
  const itemRowHeight = 72;
  const footerHeight = safeNote ? 305 : 275;
  const contentHeight = Math.max(safeItems.length * itemRowHeight, 80);
  const height = headerHeight + contentHeight + footerHeight;

  const canvas = document.createElement('canvas');
  const scale = 2; // Retina / High DPI
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Fondo principal limpio
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Borde exterior editorial
  ctx.strokeStyle = '#E8E5E0';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  // Franja superior de marca (Studio F negro editorial / Basshert ciruela profundo)
  const isBasshert = safeBrand.toLowerCase().includes('basshert');
  const brandBg = isBasshert ? '#2E1528' : '#111111';
  ctx.fillStyle = brandBg;
  ctx.fillRect(20, 20, width - 40, 92);

  // Nombre de Marca / Logo en tipografía editorial
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.textAlign = 'center';
  ctx.fillText(safeBrand.toUpperCase(), width / 2, 60);

  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.fillStyle = '#E2DFD8';
  ctx.fillText('COTIZACIÓN EXCLUSIVA', width / 2, 86);

  // Metadatos (Folio, Fecha, Asesor, Cliente)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  const metaTop = 136;
  ctx.fillStyle = '#73706B';
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('FOLIO', 40, metaTop);
  ctx.fillText('FECHA', 230, metaTop);
  ctx.fillText('ASESOR DE VENTAS', 410, metaTop);
  ctx.fillText('CLIENTE', 630, metaTop);

  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(safeQuoteNum.slice(0, 22), 40, metaTop + 20);

  const todayStr = new Date().toLocaleDateString('es-GT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  ctx.fillText(todayStr, 230, metaTop + 20);
  ctx.fillText(safeAdvisor.slice(0, 24), 410, metaTop + 20);
  ctx.fillText(safeCustomer.slice(0, 22), 630, metaTop + 20);

  // Línea separadora
  ctx.strokeStyle = '#ECE8E1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 180);
  ctx.lineTo(width - 40, 180);
  ctx.stroke();

  // Encabezado de la tabla
  const tableHeaderY = 205;
  ctx.fillStyle = '#8C8881';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('REF / SKU', 40, tableHeaderY);
  ctx.fillText('PRENDA / DETALLE', 175, tableHeaderY);
  ctx.textAlign = 'center';
  ctx.fillText('CANT.', 460, tableHeaderY);
  ctx.textAlign = 'right';
  ctx.fillText('PRECIO REG.', 575, tableHeaderY);
  ctx.fillText('DESC.', 670, tableHeaderY);
  ctx.fillText('SUBTOTAL', width - 40, tableHeaderY);

  // Renderizado de cada fila de prendas
  let currentY = tableHeaderY + 18;

  safeItems.forEach((item, index) => {
    const safeSku = String(item?.sku || 'N/A');
    const safeName = String(item?.name || 'Prenda');
    const safeSize = String(item?.size || '').trim();
    const safeColor = String(item?.color || '').trim();
    const qty = Math.max(1, Number(item?.quantity) || 1);
    const unitP = Math.max(0, Number(item?.unitPrice) || 0);
    const discPct = Math.min(100, Math.max(0, Number(item?.discountPct) || 0));
    const finalP = Number(
      item?.finalPrice !== undefined ? item.finalPrice : unitP * (1 - discPct / 100)
    );

    // Fondo alterno suave
    if (index % 2 === 0) {
      ctx.fillStyle = '#FBFBFA';
      ctx.fillRect(34, currentY - 4, width - 68, itemRowHeight - 8);
    }

    ctx.textAlign = 'left';
    // SKU
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(safeSku.slice(0, 16), 40, currentY + 22);

    // Nombre Prenda + Talla/Color
    ctx.fillStyle = '#222222';
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(safeName.slice(0, 32), 175, currentY + 20);

    const detail = [
      safeSize ? `Talla: ${safeSize}` : '',
      safeColor ? `Color: ${safeColor}` : '',
    ]
      .filter(Boolean)
      .join('  ·  ');

    if (detail) {
      ctx.fillStyle = '#7A756E';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(detail.slice(0, 42), 175, currentY + 39);
    }

    // Cantidad
    ctx.textAlign = 'center';
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`${qty}`, 460, currentY + 24);

    ctx.textAlign = 'right';
    // Precio regular
    ctx.fillStyle = discPct > 0 ? '#999999' : '#111111';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`Q${unitP.toFixed(2)}`, 575, currentY + 24);

    // % Descuento
    if (discPct > 0) {
      ctx.fillStyle = '#D9383A';
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(`-${discPct}%`, 670, currentY + 24);
    } else {
      ctx.fillStyle = '#8C8881';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('—', 670, currentY + 24);
    }

    // Total de la prenda
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`Q${(finalP * qty).toFixed(2)}`, width - 40, currentY + 24);

    currentY += itemRowHeight;
  });

  // Nota / Observaciones a la izquierda del cuadro de totales
  const boxTop = currentY + 18;
  const boxWidth = 340;
  const boxX = width - 40 - boxWidth;
  const boxHeight = safeShipping > 0 ? 160 : 138;

  const totalUnits = safeItems.reduce((acc, it) => acc + Math.max(1, Number(it?.quantity) || 1), 0);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#57534E';
  ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Resumen: ${totalUnits} prenda${totalUnits === 1 ? '' : 's'} cotizada${totalUnits === 1 ? '' : 's'}`, 40, boxTop + 26);

  if (safeNote) {
    ctx.fillStyle = '#78716C';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`Nota: ${safeNote.slice(0, 58)}`, 40, boxTop + 48);
    if (safeNote.length > 58) {
      ctx.fillText(safeNote.slice(58, 116), 40, boxTop + 65);
    }
  }

  // Fondo de la caja de resumen
  ctx.fillStyle = '#F5F4F0';
  ctx.fillRect(boxX, boxTop, boxWidth, boxHeight);
  ctx.strokeStyle = '#E0DCD3';
  ctx.strokeRect(boxX, boxTop, boxWidth, boxHeight);

  ctx.textAlign = 'left';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#666666';
  ctx.fillText('Subtotal regular:', boxX + 16, boxTop + 28);
  ctx.fillText('Ahorro / Descuento:', boxX + 16, boxTop + 54);
  if (safeShipping > 0) {
    ctx.fillText('Envío a domicilio:', boxX + 16, boxTop + 80);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#333333';
  ctx.fillText(`Q${Number(subtotal || 0).toFixed(2)}`, boxX + boxWidth - 16, boxTop + 28);

  if (Number(discountTotal) > 0) {
    ctx.fillStyle = '#227A45';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`-Q${Number(discountTotal).toFixed(2)}`, boxX + boxWidth - 16, boxTop + 54);
  } else {
    ctx.fillStyle = '#73706B';
    ctx.fillText('Q0.00', boxX + boxWidth - 16, boxTop + 54);
  }

  if (safeShipping > 0) {
    ctx.fillStyle = '#333333';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`Q${safeShipping.toFixed(2)}`, boxX + boxWidth - 16, boxTop + 80);
  }

  const dividerY = safeShipping > 0 ? boxTop + 98 : boxTop + 74;
  ctx.strokeStyle = '#D9D5CB';
  ctx.beginPath();
  ctx.moveTo(boxX + 16, dividerY);
  ctx.lineTo(boxX + boxWidth - 16, dividerY);
  ctx.stroke();

  const totalY = safeShipping > 0 ? boxTop + 132 : boxTop + 108;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('TOTAL A PAGAR:', boxX + 16, totalY);

  ctx.textAlign = 'right';
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Q${Number(grandTotal || 0).toFixed(2)}`, boxX + boxWidth - 16, totalY);

  // Mensaje de validez y agradecimiento al pie
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8C8881';
  ctx.font = 'italic 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(
    'Cotización válida por 48 horas sujeta a disponibilidad de existencias.',
    width / 2,
    height - 44
  );
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(
    `Guatemala · ${isBasshert ? 'Línea Basshert' : 'Sedes Studio F'}`,
    width / 2,
    height - 26
  );

  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
        }
      }, 'image/png');
    } catch {
      resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
    }
  });
}
