import MetaAdsReport from './MetaAdsReport.jsx';

// Informe de anuncios como página propia: lo ven todos los roles (antes vivía dentro de Marketing, solo admin y supervisor).
export default function AdsReportPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-8 pt-8 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Informe de anuncios</h1>
        <p className="mt-1 text-sm text-greige-ink">Cómo va la pauta de Meta: inversión, conversaciones, costo y la imagen de cada anuncio.</p>
      </div>
      <MetaAdsReport />
    </div>
  );
}
