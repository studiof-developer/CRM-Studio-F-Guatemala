// Barra de pestañas compartida por las pantallas que agrupan varias (Organización, Supervisión): mismo estilo que las pestañas de Marketing.
export default function TabbedPage({ tabs, active, onChange }) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 md:px-8">
      <div className="inline-flex flex-wrap rounded-xl border border-line bg-black/[0.03] p-1 dark:bg-white/[0.05]">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" onClick={() => onChange(key)} className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${active === key ? 'bg-paper text-ink shadow-sm' : 'text-greige-ink hover:text-ink'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}
