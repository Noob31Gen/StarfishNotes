import React, { useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Loader2, RefreshCw } from 'lucide-react';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';

interface ConflictResolutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  conflictingFiles: VaultFile[];
  unsyncedPaths: string[];
  onKeepLocal: (file: VaultFile) => Promise<void>;
  onKeepRemote: (file: VaultFile) => Promise<void>;
  onKeepAllLocal: () => Promise<void>;
  onKeepAllRemote: () => Promise<void>;
}

export const ConflictResolutionModal: React.FC<ConflictResolutionModalProps> = ({
  isOpen,
  onClose,
  conflictingFiles,
  unsyncedPaths,
  onKeepLocal,
  onKeepRemote,
  onKeepAllLocal,
  onKeepAllRemote,
}) => {
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [resolvingAll, setResolvingAll] = useState<'local' | 'remote' | null>(null);
  const [successPaths, setSuccessPaths] = useState<Set<string>>(new Set());

  if (!isOpen) return null;

  // Filter out files that have been successfully resolved
  const remainingFiles = conflictingFiles.filter(f => !successPaths.has(f.path));

  const handleResolveFile = async (file: VaultFile, type: 'local' | 'remote') => {
    setResolvingPath(file.path + '-' + type);
    try {
      if (type === 'local') {
        await onKeepLocal(file);
      } else {
        await onKeepRemote(file);
      }
      setSuccessPaths(prev => {
        const next = new Set(prev);
        next.add(file.path);
        return next;
      });
    } catch (err) {
      console.error('Failed to resolve file:', file.path, err);
    } finally {
      setResolvingPath(null);
    }
  };

  const handleResolveAll = async (type: 'local' | 'remote') => {
    setResolvingAll(type);
    try {
      if (type === 'local') {
        await onKeepAllLocal();
      } else {
        await onKeepAllRemote();
      }
      // Add all files to success list
      setSuccessPaths(new Set(conflictingFiles.map(f => f.path)));
      setTimeout(() => {
        onClose();
      }, 500);
    } catch (err) {
      console.error('Failed to resolve all:', type, err);
    } finally {
      setResolvingAll(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-xl bg-[#0e1017]/95 backdrop-blur-2xl border border-border/80 rounded-2xl p-6 shadow-2xl flex flex-col gap-5 animate-in fade-in zoom-in-95 duration-200 text-foreground max-h-[90vh]">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-3 select-none">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="text-amber-500 animate-pulse w-5 h-5 shrink-0" />
            <h3 className="font-heading font-bold text-base sm:text-lg">Conflict Resolution</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 hover:bg-white/[0.04] rounded-lg cursor-pointer transition-all border border-transparent"
          >
            ✕
          </button>
        </div>

        {/* Info Box */}
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-200/90 text-[0.72rem] sm:text-xs leading-relaxed p-3.5 rounded-xl flex gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-amber-400 mb-1">Dormant Tab & Remote Changes Detected</p>
            <p>
              This tab has been sitting idle for longer than 5 minutes, and remote changes have been detected on GitHub.
              Please choose whether to download remote updates or keep your local changes.
            </p>
          </div>
        </div>

        {/* Scrollable File List */}
        <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-3 max-h-[300px]">
          {remainingFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground text-xs gap-2">
              <Check className="w-8 h-8 text-emerald-500 bg-emerald-500/10 rounded-full p-1.5" />
              <span className="font-semibold text-foreground">All Conflicts Resolved!</span>
              <span>All files have been synced successfully.</span>
            </div>
          ) : (
            remainingFiles.map((file) => {
              const isUnsynced = unsyncedPaths.includes(file.path);
              const isResolvingLocal = resolvingPath === `${file.path}-local`;
              const isResolvingRemote = resolvingPath === `${file.path}-remote`;
              const isResolving = resolvingPath !== null;

              return (
                <div
                  key={file.path}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 rounded-xl border border-border/50 bg-white/[0.015] hover:bg-white/[0.03] transition-all gap-3"
                >
                  <div className="flex flex-col min-w-0 gap-1 flex-1">
                    <span className="text-xs font-bold text-foreground truncate" title={file.path}>
                      {file.name}
                    </span>
                    <span className="text-[0.625rem] text-muted-foreground/60 truncate leading-none">
                      {file.path}
                    </span>
                    <div className="flex gap-2.5 mt-1.5">
                      {isUnsynced ? (
                        <span className="text-[0.55rem] font-bold uppercase tracking-wider bg-rose-500/15 text-rose-400 px-2 py-0.5 rounded-md border border-rose-500/10">
                          Edit Conflict
                        </span>
                      ) : (
                        <span className="text-[0.55rem] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-400 px-2 py-0.5 rounded-md border border-amber-500/10">
                          Remote Updated
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions for File */}
                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                    {/* Keep Remote Button */}
                    <button
                      type="button"
                      disabled={isResolving}
                      onClick={() => handleResolveFile(file, 'remote')}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider rounded-lg border cursor-pointer transition-all",
                        isResolvingRemote
                          ? "bg-primary/20 border-primary text-primary"
                          : "bg-muted/30 border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      )}
                    >
                      {isResolvingRemote ? (
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      ) : (
                        <ArrowDown className="w-3 h-3 text-sky-400 shrink-0" />
                      )}
                      <span>Keep Remote</span>
                    </button>

                    {/* Keep Local Button */}
                    <button
                      type="button"
                      disabled={isResolving}
                      onClick={() => handleResolveFile(file, 'local')}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider rounded-lg border cursor-pointer transition-all",
                        isResolvingLocal
                          ? "bg-primary/20 border-primary text-primary"
                          : "bg-muted/30 border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      )}
                    >
                      {isResolvingLocal ? (
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      ) : (
                        <ArrowUp className="w-3 h-3 text-purple-400 shrink-0" />
                      )}
                      <span>Keep Local</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal Footer */}
        {remainingFiles.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between border-t border-border/60 pt-4 gap-3 select-none">
            {/* Batch Resolution Buttons */}
            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              <button
                type="button"
                disabled={resolvingPath !== null || resolvingAll !== null}
                onClick={() => handleResolveAll('remote')}
                className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/95 text-[0.68rem] font-bold uppercase tracking-wider px-3.5 py-2 rounded-xl transition-all cursor-pointer shadow-md"
              >
                {resolvingAll === 'remote' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>Accept All Remote</span>
              </button>

              <button
                type="button"
                disabled={resolvingPath !== null || resolvingAll !== null}
                onClick={() => handleResolveAll('local')}
                className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-muted/40 border border-border text-muted-foreground hover:bg-muted/70 hover:text-foreground text-[0.68rem] font-bold uppercase tracking-wider px-3.5 py-2 rounded-xl transition-all cursor-pointer"
              >
                {resolvingAll === 'local' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                ) : (
                  <ArrowUp className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>Keep All Local</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto flex items-center justify-center bg-transparent border border-border/40 hover:bg-white/[0.04] text-muted-foreground hover:text-foreground text-[0.68rem] font-bold uppercase tracking-wider px-4 py-2 rounded-xl transition-all cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
