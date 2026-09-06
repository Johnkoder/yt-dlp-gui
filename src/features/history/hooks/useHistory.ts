import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry } from "../types";
import {
  clearHistory as apiClearHistory,
  getHistory,
  subscribeToHistoryEvents,
} from "../historyService";

export type HistoryInitStatus = "loading" | "ready" | "error";

export interface UseHistoryReturn {
  status: HistoryInitStatus;
  entries: HistoryEntry[];
  errorMessage: string | null;
  isClearing: boolean;
  clearError: string | null;
  clearAllHistory: () => Promise<boolean>;
  reloadHistory: () => Promise<void>;
}

export function useHistory(): UseHistoryReturn {
  const [status, setStatus] = useState<HistoryInitStatus>("loading");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState<boolean>(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const loaded = await getHistory();
      setEntries((prev) => {
        const seen = new Set<number>();
        const merged: HistoryEntry[] = [];
        for (const e of prev) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            merged.push(e);
          }
        }
        for (const e of loaded) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            merged.push(e);
          }
        }
        merged.sort((a, b) => b.id - a.id);
        return merged;
      });
      setErrorMessage(null);
      setStatus("ready");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    subscribeToHistoryEvents((newEntry: HistoryEntry) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.some((e) => e.id === newEntry.id)) {
          return prev;
        }
        return [newEntry, ...prev];
      });
    })
      .then((unlistenFn) => {
        if (cancelled) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      })
      .catch((err) => {
        console.error("Failed to subscribe to history events:", err);
      });

    fetchHistory();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [fetchHistory]);

  const clearAllHistory = useCallback(async (): Promise<boolean> => {
    setIsClearing(true);
    setClearError(null);
    try {
      const result = await apiClearHistory();
      setEntries((prev) => prev.filter((entry) => entry.id >= result.nextId));
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setClearError(msg);
      return false;
    } finally {
      setIsClearing(false);
    }
  }, []);

  return {
    status,
    entries,
    errorMessage,
    isClearing,
    clearError,
    clearAllHistory,
    reloadHistory: fetchHistory,
  };
}
