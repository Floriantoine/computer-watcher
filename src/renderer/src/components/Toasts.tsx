export function Toasts({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="toasts">
      {messages.map((m, i) => <div key={i} className="toast">{m}</div>)}
    </div>
  );
}
