/**
 * Generador gráfico de tarjetas de cotización en formato PNG usando HTML5 Canvas.
 * Diseñado con estética editorial de alta gama (Studio F / Basshert):
 * - Soporta 2x DPI para nitidez cristalina en pantallas de smartphones.
 * - Desglose de Referencia, Prenda, Precio Unitario, Descuento y Total.
 * - Destacado de Ahorro y Total a Pagar.
 */

export async function generateQuoteCardBlob({
  brandName = 'STUDIO F',
  quoteNumber = 'COT-2026-0001',
  advisorName = 'Asesor Studio F',
  customerName = 'Cliente',
  items = [],
  subtotal = 0,
  discountTotal = 0,
  grandTotal = 0,
}) {
  const width = 800;
  // Altura base dinámica según la cantidad de prendas cotizadas
  const headerHeight = 220;
  const itemRowHeight = 70;
  const footerHeight = 260;
  const contentHeight = Math.max(items.length * itemRowHeight, 80);
  const height = headerHeight + contentHeight + footerHeight;

  const canvas = document.createElement('canvas');
  const scale = 2; // Retina / High DPI
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Fondo principal con tono cálido elegante (greige suave / paper)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Borde exterior refinado
  ctx.strokeStyle = '#E8E5E0';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  // Franja superior de marca
  const brandBg = brandName.toLowerCase().includes('basshert') ? '#2E1528' : '#111111';
  ctx.fillStyle = brandBg;
  ctx.fillRect(20, 20, width - 40, 90);

  // Nombre de Marca / Logo en tipografía editorial
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.letterSpacing = '4px';
  ctx.textAlign = 'center';
  ctx.fillText(brandName.toUpperCase(), width / 2, 60);

  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillStyle = '#E2DFD8';
  ctx.fillText('COTIZACIÓN EXCLUSIVA', width / 2, 85);

  // Metadatos (Folio, Fecha, Asesor, Cliente)
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';

  const metaTop = 135;
  ctx.fillStyle = '#73706B';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('FOLIO', 40, metaTop);
  ctx.fillText('FECHA', 240, metaTop);
  ctx.fillText('ASESOR', 440, metaTop);
  ctx.fillText('CLIENTE', 620, metaTop);

  ctx.fillStyle = '#1A1A1A';
  ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(quoteNumber, 40, metaTop + 20);
  
  const todayStr = new Date().toLocaleDateString('es-GT', { day: '2-digit', month: 'short', year: 'numeric' });
  ctx.fillText(todayStr, 240, metaTop + 20);
  ctx.fillText(advisorName.slice(0, 20), 440, metaTop + 20);
  ctx.fillText(customerName.slice(0, 20), 620, metaTop + 20);

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
  ctx.fillText('REF / SKU', 40, tableHeaderY);
  ctx.fillText('DESCRIPCIÓN', 180, tableHeaderY);
  ctx.textAlign = 'right';
  ctx.fillText('PRECIO REG.', 480, tableHeaderY);
  ctx.fillText('DESCUENTO', 620, tableHeaderY);
  ctx.fillText('TOTAL', width - 40, tableHeaderY);

  // Renderizado de cada fila de prendas
  let currentY = tableHeaderY + 20;

  items.forEach((item, index) => {
    // Fondo alterno suave
    if (index % 2 === 0) {
      ctx.fillStyle = '#FBFBFA';
      ctx.fillRect(36, currentY - 5, width - 72, itemRowHeight - 10);
    }

    ctx.textAlign = 'left';
    // SKU
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(item.sku, 40, currentY + 22);

    // Nombre Prenda + Talla/Color
    ctx.fillStyle = '#333333';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const detail = [item.size ? `Talla: ${item.size}` : '', item.color ? `Color: ${item.color}` : ''].filter(Boolean).join(' · ');
    ctx.fillText(item.name.slice(0, 28), 180, currentY + 18);
    if (detail) {
      ctx.fillStyle = '#8C8881';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(detail, 180, currentY + 36);
    }

    ctx.textAlign = 'right';
    // Precio regular
    ctx.fillStyle = item.discountPct > 0 ? '#999999' : '#111111';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const unitP = Number(item.unitPrice || 0);
    ctx.fillText(`Q${unitP.toFixed(2)}`, 480, currentY + 22);

    // % Descuento
    if (item.discountPct > 0) {
      ctx.fillStyle = '#D9383A';
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(`-${Number(item.discountPct)}%`, 620, currentY + 22);
    } else {
      ctx.fillStyle = '#8C8881';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('0%', 620, currentY + 22);
    }

    // Total de la prenda
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const finalP = Number(item.finalPrice || (unitP * (1 - (item.discountPct || 0) / 100)));
    const qty = Number(item.quantity || 1);
    ctx.fillText(`Q${(finalP * qty).toFixed(2)}`, width - 40, currentY + 22);

    currentY += itemRowHeight;
  });

  // Caja de Totales (Footer)
  const boxTop = currentY + 20;
  const boxWidth = 320;
  const boxX = width - 40 - boxWidth;

  // Fondo de la caja de resumen
  ctx.fillStyle = '#F5F4F0';
  ctx.fillRect(boxX, boxTop, boxWidth, 140);
  ctx.strokeStyle = '#E0DCD3';
  ctx.strokeRect(boxX, boxTop, boxWidth, 140);

  ctx.textAlign = 'left';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#666666';
  ctx.fillText('Subtotal regular:', boxX + 16, boxTop + 30);
  ctx.fillText('Descuento aplicado:', boxX + 16, boxTop + 60);

  ctx.textAlign = 'right';
  ctx.fillText(`Q${Number(subtotal).toFixed(2)}`, boxX + boxWidth - 16, boxTop + 30);

  if (discountTotal > 0) {
    ctx.fillStyle = '#227A45'; // Verde ahorro
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`-Q${Number(discountTotal).toFixed(2)}`, boxX + boxWidth - 16, boxTop + 60);
  } else {
    ctx.fillText('Q0.00', boxX + boxWidth - 16, boxTop + 60);
  }

  // Divisor dentro del cuadro de totales
  ctx.strokeStyle = '#D9D5CB';
  ctx.beginPath();
  ctx.moveTo(boxX + 16, boxTop + 78);
  ctx.lineTo(boxX + boxWidth - 16, boxTop + 78);
  ctx.stroke();

  // Gran Total destacado
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('TOTAL A PAGAR:', boxX + 16, boxTop + 110);

  ctx.textAlign = 'right';
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Q${Number(grandTotal).toFixed(2)}`, boxX + boxWidth - 16, boxTop + 110);

  // Mensaje de validez y agradecimiento al pie
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8C8881';
  ctx.font = 'italic 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Cotización válida por 48 horas sujeta a disponibilidad de existencias.', width / 2, height - 45);
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Guatemala · Studio F Online', width / 2, height - 28);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob);
    }, 'image/png');
  });
}
