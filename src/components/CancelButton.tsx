import { Ban, Loader2 } from "lucide-react";
import "./CancelButton.css";

interface CancelButtonProps {
  cancelling: boolean;
  onClick: () => void;
}

export function CancelButton({ cancelling, onClick }: CancelButtonProps) {
  return (
    <button
      type="button"
      className="cancel-button"
      disabled={cancelling}
      onClick={onClick}
    >
      {cancelling ? (
        <Loader2 size={15} strokeWidth={2.25} className="spin" />
      ) : (
        <Ban size={15} strokeWidth={2.25} />
      )}
      {cancelling ? "Cancelling…" : "Cancel"}
    </button>
  );
}
