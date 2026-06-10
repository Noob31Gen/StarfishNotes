import React, { useState, useEffect } from 'react';
import { Lock, CheckCircle2, RefreshCw, ShieldAlert, ChevronDown, ShieldCheck, Shield, Trash2 } from 'lucide-react';
import type { StorageMode } from '../utils/crypto';
import { cn } from '../utils/cn';

const isSharedHostingDomain = (): boolean => {
  const host = window.location.hostname;
  return host.endsWith('.github.io') ||
         host.endsWith('.netlify.app') ||
         host.endsWith('.vercel.app') ||
         host.endsWith('.pages.dev') ||
         host.endsWith('.ondigitalocean.app');
};

interface AuthScreenProps {
  githubToken: string;
  setGithubToken: (token: string) => void;
  repoName: string;
  setRepoName: (repo: string) => void;
  branchName: string;
  setBranchName: (branch: string) => void;
  storageMode: StorageMode;
  setStorageMode: (mode: StorageMode) => void;
  masterPassphrase: string;
  setMasterPassphrase: (passphrase: string) => void;
  authError: string;
  isConnecting: boolean;
  handleConnect: (e: React.FormEvent) => Promise<void>;

  // Offline additions
  authMode: 'github' | 'local';
  setAuthMode: (mode: 'github' | 'local') => void;
  isPersistentStorage: boolean;
  requestPersistentStorage: () => Promise<boolean>;
  handleConnectOffline: (e: React.FormEvent) => Promise<void>;
  onPurgeStorage: () => Promise<void>;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  githubToken,
  setGithubToken,
  repoName,
  setRepoName,
  branchName,
  setBranchName,
  storageMode,
  setStorageMode,
  masterPassphrase,
  setMasterPassphrase,
  authError,
  isConnecting,
  handleConnect,

  authMode,
  setAuthMode,
  isPersistentStorage,
  requestPersistentStorage,
  handleConnectOffline,
  onPurgeStorage,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isRequestingPersist, setIsRequestingPersist] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<string | null>(null);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeFeedback, setPurgeFeedback] = useState<string | null>(null);

  const sharedDomain = isSharedHostingDomain();

  useEffect(() => {
    if (sharedDomain && storageMode === 'keychain') {
      setStorageMode('session');
    }
  }, [sharedDomain, storageMode, setStorageMode]);

  const storageOptions: { value: StorageMode; label: string; desc: string; disabled?: boolean }[] = [
    { value: 'session', label: 'Tab Session Storage (Default)', desc: 'Survives F5 page refresh, wiped when closed' },
    {
      value: 'keychain',
      label: sharedDomain ? 'Browser Saved Passwords (Keychain) ⚠️' : 'Browser Saved Passwords (Keychain)',
      desc: sharedDomain
        ? 'Disabled: Keychain cannot be securely isolated on shared hosting domains (e.g. vercel, netlify, github pages).'
        : authMode === 'github'
          ? 'Stores token inside your browser\'s secure credential manager'
          : 'Stores vault seed inside your browser\'s secure credential manager',
      disabled: sharedDomain
    },
    {
      value: 'encrypted',
      label: 'AES-GCM Encrypted LocalStorage',
      desc: authMode === 'github'
        ? 'Persists locally, requires master lock password'
        : 'Encrypts IndexedDB vault records, requires master lock password'
    },
    {
      value: 'plain',
      label: 'Browser-bound System-key Encrypted Storage',
      desc: 'Encrypted via system-generated key, no password required'
    },
    { value: 'memory', label: 'Strict In-Memory React state', desc: 'Keeps token strictly in volatile memory, wiped on F5' },
  ];

  const currentOption = storageOptions.find(opt => opt.value === storageMode) || storageOptions[0];

  const handlePersistClick = async () => {
    setIsRequestingPersist(true);
    setStorageFeedback(null);
    try {
      const success = await requestPersistentStorage();
      if (success) {
        setStorageFeedback("Storage secured! The browser has marked this database non-evictable.");
      } else {
        setStorageFeedback("Denied: Persistent storage is only granted when the site is loaded over HTTPS or localhost, bookmarked, or pinned.");
      }
    } catch {
      setStorageFeedback("Error requesting persistent storage.");
    } finally {
      setIsRequestingPersist(false);
    }
  };

  return (
    <div className="flex flex-col w-full min-h-[100dvh] bg-radial from-[oklch(0.12_0.04_275)] to-[oklch(0.06_0.01_260)] fixed inset-0 z-50 p-4 overflow-y-auto">
      {/* Visual background ambient blobs */}
      <div className="absolute top-[20%] left-[25%] w-[400px] h-[400px] bg-primary/10 rounded-full blur-[100px] pointer-events-none animate-pulse-soft" />
      <div className="absolute bottom-[20%] right-[25%] w-[350px] h-[350px] bg-secondary/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-[450px] m-auto max-w-full bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-8 shadow-2xl animate-fade-in flex flex-col gap-5 relative">
        <div className="text-center">
          <div className="flex justify-center mb-3">
            <div className="p-3.5 bg-primary/10 rounded-full border border-primary/20 shadow-inner glow-primary/10">
              <svg viewBox="0 0 24 24" className="w-8 h-8 text-secondary" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                <path d="M9 18c-4.51 2-5-2-7-2" />
              </svg>
            </div>
          </div>
          <h1 className="font-heading font-bold text-3xl tracking-tight bg-gradient-to-r from-white via-primary to-accent bg-clip-text text-transparent mb-1.5 animate-pulse-soft">
            Starfish Notes
          </h1>
          <p className="text-muted-foreground text-xs font-semibold leading-relaxed">
            I created this out of necessity. I wanted client-side web-based note taking alternative to Obsidian. This project is open source. It takes md and supports canvas, base, images, attachments, text editing etc. It runs fully in-browser, supports offline caching and only connects to github to sync.
          </p>
        </div>

        {/* Tab Selector: Cloud vs Offline */}
        <div className="flex bg-muted/40 border border-border/80 rounded-xl p-1 shrink-0 z-10">
          <button
            type="button"
            onClick={() => setAuthMode('github')}
            className={cn(
              "flex-1 py-2 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer text-center",
              authMode === 'github'
                ? "bg-card text-foreground shadow-lg border border-border/80"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            GitHub Cloud Vault
          </button>
          <button
            type="button"
            onClick={() => setAuthMode('local')}
            className={cn(
              "flex-1 py-2 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer text-center",
              authMode === 'local'
                ? "bg-card text-foreground shadow-lg border border-border/80"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Local Offline Vault
          </button>
        </div>

        <form className="flex flex-col gap-4" onSubmit={authMode === 'github' ? handleConnect : handleConnectOffline}>
          {authMode === 'github' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center px-1">
                  <span className="text-[0.75rem] font-bold text-muted-foreground uppercase tracking-wider">
                    GitHub Token
                  </span>
                  <a
                    href="https://github.com/settings/tokens?type=beta"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[0.75rem] text-secondary hover:text-secondary/80 font-semibold transition-colors hover:underline"
                  >
                    Create fine-grained token ↗
                  </a>
                </div>
                <input
                  type="password"
                  name="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="github_pat_..."
                  autoComplete="current-password"
                  className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[0.75rem] font-bold text-muted-foreground uppercase tracking-wider px-1">
                    Repository Name
                  </span>
                  <input
                    type="text"
                    name="username"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="username/notes-vault"
                    autoComplete="username"
                    className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[0.75rem] font-bold text-muted-foreground uppercase tracking-wider px-1">
                    Branch
                  </span>
                  <input
                    type="text"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="main"
                    className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3 p-4 bg-amber-500/10 border border-amber-500/25 rounded-xl animate-fade-in">
              <div className="flex gap-2 items-start">
                <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-bold text-amber-500">Offline Storage Warning</span>
                  <span className="text-[0.7rem] text-foreground/80 leading-relaxed font-semibold">
                    Notes are stored strictly inside your browser's local cache (IndexedDB). Clearing cookies/site data, browser resets, or disk cleaners will permanently wipe your notes.
                  </span>
                </div>
              </div>

              <div className="flex justify-between items-center gap-4 bg-muted/30 p-2.5 rounded-lg border border-border/40 mt-1">
                <div className="flex items-center gap-1.5">
                  {isPersistentStorage ? (
                    <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <Shield className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-[0.65rem] font-bold text-muted-foreground uppercase tracking-wide">
                    Storage: {isPersistentStorage ? 'Secured (Persistent)' : 'Best Effort'}
                  </span>
                </div>
                {!isPersistentStorage && (
                  <button
                    type="button"
                    onClick={handlePersistClick}
                    disabled={isRequestingPersist}
                    className="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 hover:border-primary/40 rounded text-[0.65rem] font-bold transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isRequestingPersist ? 'Securing...' : 'Secure Storage'}
                  </button>
                )}
              </div>

              {storageFeedback && (
                <div className={cn(
                  "text-[0.68rem] leading-normal font-semibold px-2.5 py-1.5 rounded-lg border animate-fade-in select-text",
                  isPersistentStorage
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    : "bg-amber-500/10 border-amber-500/20 text-amber-400"
                )}>
                  {storageFeedback}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5 relative z-50">
            <span className="text-[0.75rem] font-bold text-muted-foreground uppercase tracking-wider px-1">
              {authMode === 'github' ? 'Token Storage Security' : 'Vault Lock Protection'}
            </span>

            {/* Custom Dropdown Trigger Button */}
            <div className="relative">
              {isDropdownOpen && (
                <div
                  className="fixed inset-0 z-10 bg-transparent cursor-default"
                  onClick={() => setIsDropdownOpen(false)}
                />
              )}

              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 hover:border-primary/60 transition-premium cursor-pointer flex items-center justify-between text-left animate-in fade-in duration-200"
              >
                <span className="truncate">{currentOption.label}</span>
                <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isDropdownOpen ? 'transform rotate-180' : ''}`} />
              </button>

              {/* Custom Dropdown Options Menu */}
              {isDropdownOpen && (
                <div className="absolute bottom-full mb-2 sm:top-full sm:bottom-auto sm:mt-2 left-0 w-full bg-[#12131a] border border-border rounded-xl shadow-2xl p-1.5 flex flex-col gap-0.5 z-20 animate-in fade-in zoom-in-95 duration-100 max-h-[220px] overflow-y-auto">
                  {storageOptions.map((opt) => {
                    const isSelected = opt.value === storageMode;
                    if (opt.disabled) {
                      return (
                        <div
                          key={opt.value}
                          className="w-full text-left px-4 py-2.5 rounded-xl text-xs flex flex-col gap-0.5 border border-transparent opacity-50 bg-black/25 cursor-not-allowed select-none"
                        >
                          <span className="font-semibold text-muted-foreground">{opt.label}</span>
                          <span className="text-[0.65rem] text-destructive font-medium leading-normal">{opt.desc}</span>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setStorageMode(opt.value);
                          setIsDropdownOpen(false);
                        }}
                        className={cn(
                          "w-full text-left px-4 py-2.5 rounded-xl text-xs transition-premium cursor-pointer flex flex-col gap-0.5 border border-transparent",
                          isSelected
                            ? "bg-gradient-to-r from-primary/12 to-accent/8 text-accent font-semibold border-primary/25 shadow-xs shadow-primary/5"
                            : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground hover:border-border/40"
                        )}
                      >
                        <span className="font-semibold text-foreground">{opt.label}</span>
                        <span className="text-[0.65rem] text-muted-foreground/80 font-medium">{opt.desc}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <p className="text-[0.7rem] text-muted-foreground/80 leading-relaxed px-1 mt-0.5 font-medium select-none">
              {storageMode === 'session' && (authMode === 'github' ? "Tab session: survives page reload (F5), credentials wiped on tab close." : "Tab session: notes are temporarily stored in memory, wiped on close.")}
              {storageMode === 'keychain' && (authMode === 'github' ? "Browser Manager: saves credentials securely inside your browser's password manager." : "Browser lock: encrypts offline database and locks decryption seed inside your browser's credential storage.")}
              {storageMode === 'encrypted' && (authMode === 'github' ? "Encrypted LocalStorage: encrypts your PAT using AES-GCM, requires password." : "Encrypted LocalStorage: encrypts your IndexedDB database entries using AES-GCM, requires password.")}
              {storageMode === 'plain' && (authMode === 'github' ? "Browser-bound System-key: encrypts token via client-side system key. Wipes on logout." : "Browser-bound System-key: encrypts local database records via client-side system key. Wipes on logout.")}
              {storageMode === 'memory' && (authMode === 'github' ? "Volatile memory: kept strictly in active React state. Lost on F5 reload." : "Volatile memory: kept strictly in volatile React state. Notes wiped on F5 reload.")}
            </p>
          </div>

          {(storageMode === 'encrypted' || (authMode === 'local' && storageMode === 'keychain')) && (
            <div className="flex flex-col gap-1.5 transition-all duration-300 transform scale-y-100 origin-top">
              <span className="text-[0.75rem] font-bold text-muted-foreground uppercase tracking-wider px-1">
                {storageMode === 'encrypted' ? 'Define Master Passphrase' : 'Vault Identity (Keychain Identifier)'}
              </span>
              <input
                type="password"
                value={masterPassphrase}
                onChange={(e) => setMasterPassphrase(e.target.value)}
                placeholder={storageMode === 'encrypted' ? "Create custom lock password..." : "vault_local"}
                className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              />
            </div>
          )}

          {authError && (
            <div className="flex gap-3 p-3.5 bg-destructive/10 border-l-3 border-destructive rounded-xl animate-float/50">
              <ShieldAlert className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <span className="text-xs text-foreground/90 leading-relaxed font-semibold">{authError}</span>
            </div>
          )}

          {purgeFeedback && (
            <div className="flex gap-3 p-3.5 bg-emerald-500/10 border-l-3 border-emerald-500 rounded-xl animate-fade-in">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              <span className="text-xs text-foreground/90 leading-relaxed font-semibold">{purgeFeedback}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isConnecting}
            className="flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white font-semibold py-3 px-6 rounded-xl transition-all duration-300 transform hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-50 disabled:pointer-events-none cursor-pointer mt-2"
          >
            {isConnecting ? (
              <RefreshCw className="w-4.5 h-4.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4.5 h-4.5" />
            )}
            {authMode === 'github' ? 'Authenticate & Open Cloud Vault' : 'Initialize & Open Local Vault'}
          </button>
        </form>

        {authMode === 'github' && (
          <div className="flex gap-3 bg-white/[0.02] border border-border rounded-xl p-3.5 text-xs text-muted-foreground">
            <Lock className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <span className="font-semibold text-foreground">Token Permissions Guide</span>
              <span className="font-medium">
                Configure your GitHub fine-grained token with:
                <ul className="list-disc pl-4 mt-1 flex flex-col gap-0.5">
                  <li><strong>Contents:</strong> Read & Write (syncs notes)</li>
                  <li><strong>Metadata:</strong> Read-only (required)</li>
                </ul>
              </span>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-1 pt-3 border-t border-border/20">
          <button
            type="button"
            onClick={() => setShowPurgeConfirm(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-destructive/20 hover:border-destructive/40 bg-destructive/5 hover:bg-destructive/10 text-destructive text-xs font-semibold cursor-pointer transition-all duration-200 select-none"
          >
            <Trash2 size={13} className="text-destructive/75" />
            <span>Purge Local Storage & Cache</span>
          </button>
        </div>

        <div className="text-center mt-1 pt-1 border-t border-border/20">
          <a
            href="https://github.com/Noob31Gen/StarfishNotes"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[0.7rem] text-muted-foreground/60 hover:text-primary transition-all duration-200 font-semibold hover:underline"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            Starfish Notes Source Code
          </a>
        </div>
      </div>

      {/* Purge Confirmation Modal */}
      {showPurgeConfirm && (
        <div 
          className="fixed inset-0 z-[1300] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowPurgeConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200 text-foreground"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center text-destructive shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Purge Local Storage
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  This action is permanent and cannot be undone.
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground/80 leading-relaxed font-semibold">
              This will permanently delete all locally cached files, saved credentials, and settings in this browser. Are you sure you want to wipe this vault?
            </p>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setShowPurgeConfirm(false)}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer select-none"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowPurgeConfirm(false);
                  await onPurgeStorage();
                  setPurgeFeedback("Local storage has been successfully purged.");
                  setTimeout(() => setPurgeFeedback(null), 5000);
                }}
                className="flex-1 h-10 rounded-xl bg-destructive hover:bg-destructive/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-destructive/20 select-none"
              >
                Purge Storage
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
