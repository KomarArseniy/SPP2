export default function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button className="toast__close" onClick={() => onDismiss(t.id)} aria-label="Закрыть">×</button>
        </div>
      ))}
    </div>
  );
}
