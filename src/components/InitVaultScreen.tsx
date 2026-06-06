import React from 'react';
import { Folder, LogOut, RefreshCw, Plus } from 'lucide-react';

interface InitVaultScreenProps {
  repoName: string;
  branchName: string;
  isRepoEmpty: boolean;
  isInitializing: boolean;
  handleInitializeVault: () => Promise<void>;
  handleLogout: () => void;
}

export const InitVaultScreen: React.FC<InitVaultScreenProps> = ({
  repoName,
  branchName,
  isRepoEmpty,
  isInitializing,
  handleInitializeVault,
  handleLogout,
}) => {
  return (
    <div className="flex items-center justify-center w-screen h-screen bg-background p-4 relative">
      {/* Visual background ambient blobs */}
      <div className="absolute top-[30%] left-[30%] w-[350px] h-[350px] bg-primary/10 rounded-full blur-[100px] pointer-events-none animate-pulse-soft" />

      <div className="w-[500px] max-w-full bg-card/80 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl animate-fade-in flex flex-col gap-6 items-center text-center">
        <Folder className="w-12 h-12 text-primary glow-primary/20 animate-float" />

        <h2 className="font-heading font-bold text-2xl tracking-tight text-foreground">
          Initialize Note-Taking Vault
        </h2>

        {isRepoEmpty ? (
          <div className="flex flex-col gap-3">
            <p className="text-secondary font-semibold text-sm bg-secondary/10 border-l-4 border-secondary px-4 py-3 rounded-xl text-left leading-relaxed">
              Your repository is completely empty! Clicking "Initialize" will automatically create the branch <strong>"{branchName}"</strong> and set up the Starfish Notes environment.
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed text-left px-1">
              We will commit a secure compatibility file (<code>.vault-compat.json</code>) and a sample note file directly to establish the branch.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-muted-foreground text-sm leading-relaxed text-left px-2">
            <p>
              Your connected repository <strong>{repoName} ({branchName})</strong> is accessible, but it does not contain our compatibility metadata marker (<code>.vault-compat.json</code>).
            </p>
            <p className="text-xs">
              Clicking initialize will create the compatibility marker and set up a sample note file without affecting other files in the repo.
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 w-full justify-center mt-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center justify-center gap-2 bg-muted hover:bg-muted-foreground/10 border border-border text-foreground font-medium py-2.5 px-5 rounded-xl transition-all duration-200 cursor-pointer w-full sm:w-auto"
          >
            <LogOut className="w-4 h-4" />
            Switch Repository
          </button>
          <button
            type="button"
            onClick={handleInitializeVault}
            disabled={isInitializing}
            className="flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-white font-semibold py-2.5 px-5 rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:pointer-events-none w-full sm:w-auto"
          >
            {isInitializing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Initialize Repository
          </button>
        </div>
      </div>
    </div>
  );
};
