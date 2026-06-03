import React from 'react';
import { Lock, Key, RefreshCw } from 'lucide-react';
import type { StorageMode } from '../utils/crypto';

interface LockScreenProps {
  unlockPassphrase: string;
  setUnlockPassphrase: (pass: string) => void;
  unlockError: string;
  isConnecting: boolean;
  handleUnlock: (e: React.FormEvent) => Promise<void>;
  handleLogout: () => void;
  storageMode: StorageMode;
}

export const LockScreen: React.FC<LockScreenProps> = ({
  unlockPassphrase,
  setUnlockPassphrase,
  unlockError,
  isConnecting,
  handleUnlock,
  handleLogout,
  storageMode,
}) => {
  const isKeychain = storageMode === 'keychain';

  return (
    <div className="flex items-center justify-center w-screen h-screen bg-radial from-[oklch(0.12_0.04_275)] to-[oklch(0.06_0.01_260)] absolute top-0 left-0 z-50 p-4">
      {/* Visual background ambient blobs */}
      <div className="absolute top-[20%] left-[25%] w-[400px] h-[400px] bg-primary/10 rounded-full blur-[100px] pointer-events-none animate-pulse-soft" />
      
      <div className="w-[440px] max-w-full bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl animate-fade-in flex flex-col gap-6 relative">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3.5 bg-primary/10 rounded-full border border-primary/20 shadow-inner glow-primary/10">
              <Lock className="w-8 h-8 text-primary" />
            </div>
          </div>
          <h1 className="font-heading font-bold text-2xl tracking-tight text-foreground mb-1.5">
            {isKeychain ? 'Unlock with Browser Keychain' : 'Unlock Workspace'}
          </h1>
          <p className="text-muted-foreground text-sm font-medium px-4">
            {isKeychain
              ? 'Your session is secured using your browser\'s saved passwords manager.'
              : 'Your session is locked. Enter your master passphrase to load credentials.'}
          </p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={handleUnlock}>
          {!isKeychain && (
            <div className="flex flex-col gap-1.5 animate-in fade-in duration-200">
              <span className="text-[0.75rem] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Master Passphrase
              </span>
              <input
                type="password"
                value={unlockPassphrase}
                onChange={(e) => setUnlockPassphrase(e.target.value)}
                placeholder="Enter password..."
                className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              />
            </div>
          )}

          {unlockError && (
            <span className="text-xs text-destructive font-medium px-1">
              {unlockError}
            </span>
          )}

          <div className="flex flex-col gap-2 mt-2">
            <button
              type="submit"
              disabled={isConnecting}
              className="flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-white font-semibold py-2.5 px-6 rounded-xl transition-all duration-200 transform hover:-translate-y-0.5 disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              {isConnecting ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Key className="w-4 h-4" />
              )}
              {isKeychain ? 'Unlock Workspace with Browser Key' : 'Unlock Connection'}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center justify-center gap-2 bg-muted hover:bg-muted-foreground/10 border border-border text-foreground text-sm font-medium py-2.5 px-6 rounded-xl transition-all duration-200 cursor-pointer"
            >
              Clear saved credentials & Switch User
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
